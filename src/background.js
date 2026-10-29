/**
 * Service Worker：所有跨域请求都在这里发出。
 *
 * 流程：
 *   content script 读出豆瓣页面信息 → 发 LOOKUP → 这里决定用 OMDb 还是直连 IMDb
 *   → 查缓存 → 需要时先「片名 → tt id」搜索匹配 → 取评分 → 回传并写缓存。
 *
 * 放在 background 而不是 content script 的原因：
 *   1. content script 的 fetch 受页面 CORS 限制；
 *   2. 扩展声明了 host_permissions 后，Service Worker 的请求不受 CORS 约束；
 *   3. 便于统一做缓存、去重和限流。
 */

import { getSettings, saveSettings } from './lib/settings.js';
import { getCache, setCache, deleteCache, clearCache, pruneCache } from './lib/cache.js';
import {
  buildSearchUrl,
  buildTitleUrl,
  parseSearch,
  requestOmdb,
  toRating,
  OmdbError,
} from './lib/omdb.js';
import { candidateImdbId, pickBest } from './lib/match.js';
import { fetchDirectRating, parseSuggestion, IMDB_SUGGEST } from './lib/imdb-direct.js';
import { TOP250 } from '../data/top250.js';
import { TOP250_TV } from '../data/top250-tv.js';
import { buildRankIndex, compact, isValidTop250, parseChartHtml } from './lib/top250.js';

const TTL_RATING = 7 * 24 * 60 * 60 * 1000;
const TTL_MAP = 30 * 24 * 60 * 60 * 1000;
const TTL_DIRECT = 24 * 60 * 60 * 1000;

/** 同一部片的并发请求合并，避免页面重绘时重复打 API。 */
const inflight = new Map();

/** Top 250 索引（内存缓存，刷新后置空重新读）。 */
let top250State = null;

chrome.runtime.onInstalled.addListener(() => {
  pruneCache().catch(() => {});
  ensureTop250Alarm();
});
chrome.runtime.onStartup.addListener(() => {
  pruneCache().catch(() => {});
  ensureTop250Alarm();
});

// 每天唤醒一次 Service Worker 去更新 Top 250（浏览器重启后 alarm 会被清掉，所以 startup 里重建）
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === TOP250_ALARM) autoRefreshTop250().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) =>
      sendResponse({
        ok: false,
        code: 'UNKNOWN',
        message: err?.message ? String(err.message) : '未知错误',
      })
    );
  return true; // 保持消息通道，异步 sendResponse
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'LOOKUP':
      return lookup(message.payload || {}, sender);
    case 'GET_SETTINGS':
      return { ok: true, settings: await getSettings() };
    case 'SAVE_SETTINGS':
      return { ok: true, settings: await saveSettings(message.patch || {}) };
    case 'REFRESH_TOP250':
      return refreshTop250();
    case 'TOP250_STATUS': {
      const movie = await getChartState('movie');
      const tv = await getChartState('tv');
      return {
        ok: true,
        movie: { total: movie.total, updatedAt: movie.updatedAt },
        tv: { total: tv.total, updatedAt: tv.updatedAt },
      };
    }
    case 'CLEAR_CACHE': {
      const removed = await clearCache();
      return { ok: true, removed };
    }
    case 'TEST_KEY': {
      const key = String(message.apiKey || '').trim();
      if (!key) return { ok: false, code: 'NO_KEY' };
      try {
        const json = await requestOmdb(buildTitleUrl({ apiKey: key, imdbId: 'tt0111161' }));
        return { ok: true, title: json.Title, rating: Number(json.imdbRating) };
      } catch (err) {
        return { ok: false, code: err.code || 'UNKNOWN', message: err.message };
      }
    }
    default:
      return { ok: false, code: 'BAD_MESSAGE' };
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function normalizeImdbId(value) {
  const m = String(value || '').match(/tt\d{6,10}/);
  return m ? m[0] : null;
}

async function lookup(payload, sender) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, code: 'DISABLED' };

  const apiKey = String(settings.apiKey || '').trim();
  const useOmdb = settings.provider === 'omdb' || (settings.provider === 'auto' && !!apiKey);

  const key = `${payload.doubanId || payload.titles?.[0] || 'unknown'}|${useOmdb}`;
  if (inflight.has(key)) return inflight.get(key);

  const task = (useOmdb ? lookupViaOmdb(payload, apiKey) : lookupViaDirect(payload)).then(async (result) => {
    if (result.ok) {
      result.prefs = { showVotes: settings.showVotes, showExtra: settings.showExtra };
      const ranking = await getTop250Rank(result.data?.imdbId, result.data?.type || payload.kind);
      if (ranking) result.data.top250 = ranking;
    }
    if (sender?.tab?.id != null) updateBadge(sender.tab.id, result);
    return result;
  });

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

async function lookupViaOmdb(payload, apiKey) {
  const pageId = normalizeImdbId(payload.imdbId);
  const mapKey = payload.doubanId ? `map:${payload.doubanId}` : null;
  let imdbId = pageId || (mapKey ? normalizeImdbId(await getCache(mapKey)) : null);

  try {
    if (imdbId) {
      const cached = await getCache(`rating:${imdbId}`);
      if (cached) return { ok: true, data: cached, cached: true };
    } else {
      imdbId = await resolveViaSearch(payload, apiKey);
      if (!imdbId) return { ok: false, code: 'NO_MATCH' };
      const cached = await getCache(`rating:${imdbId}`);
      if (cached) {
        if (mapKey) await setCache(mapKey, imdbId, TTL_MAP);
        return { ok: true, data: cached, cached: true };
      }
    }

    const data = await fetchOmdbRating(imdbId, apiKey);
    await Promise.all([
      setCache(`rating:${imdbId}`, data, TTL_RATING),
      mapKey ? setCache(mapKey, imdbId, TTL_MAP) : Promise.resolve(),
    ]);
    return { ok: true, data, cached: false };
  } catch (err) {
    // 页面上的 tt id 失效时，退回到按片名搜索
    if (err instanceof OmdbError && err.code === 'NOT_FOUND' && imdbId && mapKey) {
      try {
        await deleteCache(mapKey);
        const retry = await resolveViaSearch(payload, apiKey);
        if (retry && retry !== imdbId) {
          const data = await fetchOmdbRating(retry, apiKey);
          await setCache(`rating:${retry}`, data, TTL_RATING);
          await setCache(mapKey, retry, TTL_MAP);
          return { ok: true, data, cached: false };
        }
      } catch {
        /* 落到下面的错误处理 */
      }
    }
    return { ok: false, code: err.code || 'UNKNOWN', message: friendlyMessage(err) };
  }
}

/** 把 API 的英文报错换成卡片里能直接读的中文。 */
function friendlyMessage(err) {
  switch (err?.code) {
    case 'BAD_KEY':
      return 'API Key 无效或已失效，请重新填写';
    case 'RATE_LIMIT':
      return '这个 Key 今天的额度用完了，明天会自动恢复';
    case 'NETWORK':
      return '连不上 omdbapi.com，请检查网络或代理';
    case 'NOT_FOUND':
      return 'IMDb 上查不到这部电影';
    case 'TOO_MANY':
      return '搜索结果太多，换一个片名再试试';
    default:
      return err?.message || '查询失败';
  }
}

async function fetchOmdbRating(imdbId, apiKey) {
  const json = await requestOmdb(buildTitleUrl({ apiKey, imdbId }));
  return toRating(json);
}

/** 「片名 → IMDb id」：用 OMDb 搜索接口，多组关键词依次尝试。 */
async function resolveViaSearch(payload, apiKey) {
  const titles = (payload.titles || []).filter(Boolean);
  if (!titles.length) return null;

  const year = payload.year ? Number(payload.year) : null;
  const attempts = [];
  for (const title of titles.slice(0, 3)) {
    if (year) attempts.push({ query: title, year });
    attempts.push({ query: title });
  }

  for (const attempt of attempts.slice(0, 4)) {
    let list = [];
    try {
      const json = await requestOmdb(
        buildSearchUrl({ apiKey, query: attempt.query, year: attempt.year, type: payload.kind === 'series' ? 'series' : undefined })
      );
      list = parseSearch(json);
    } catch (err) {
      if (err.code === 'NOT_FOUND' || err.code === 'TOO_MANY') continue;
      throw err;
    }
    if (!list.length) continue;

    const { best, confident } = pickBest(list, {
      titles,
      year,
      kinds: payload.kind === 'series' ? ['series'] : ['movie'],
    });
    const id = candidateImdbId(best);
    if (confident && id) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 直连模式（无 Key，实验性）
// ---------------------------------------------------------------------------

async function lookupViaDirect(payload) {
  // 刚失败过就先不重试，避免每打开一部片都要等几秒
  if (await getCache('direct:blocked')) {
    return { ok: false, code: 'DIRECT_BLOCKED', message: 'IMDb 官网会拦截插件直接抓取' };
  }

  const pageId = normalizeImdbId(payload.imdbId);
  let imdbId = pageId;

  if (imdbId) {
    const cached = await getCache(`rating:${imdbId}`);
    if (cached) return { ok: true, data: cached, cached: true };
  } else {
    imdbId = await resolveViaSuggestion(payload);
    if (!imdbId) return { ok: false, code: 'NO_MATCH' };
  }

  try {
    const result = await fetchDirectRating(imdbId);
    const data = {
      imdbId,
      title: payload.titles?.[0] || result.title || '',
      year: payload.year || '',
      rating: result.rating,
      votes: result.votes,
      url: `https://www.imdb.com/title/${imdbId}/`,
      extras: [],
      source: result.source,
      fetchedAt: Date.now(),
    };
    await setCache(`rating:${imdbId}`, data, TTL_DIRECT);
    if (payload.doubanId) await setCache(`map:${payload.doubanId}`, imdbId, TTL_MAP);
    return { ok: true, data, cached: false };
  } catch (err) {
    if (err.code === 'DIRECT_BLOCKED') await setCache('direct:blocked', true, 60 * 60 * 1000);
    return { ok: false, code: err.code || 'DIRECT_BLOCKED', message: err.message };
  }
}

/** 用 IMDb 官方「建议」接口（无需 Key、无 WAF）把片名换成 tt id。 */
async function resolveViaSuggestion(payload) {
  const titles = (payload.titles || []).filter(Boolean).slice(0, 3);
  const year = payload.year ? Number(payload.year) : null;

  for (const title of titles) {
    try {
      const res = await fetch(IMDB_SUGGEST(title), { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const list = parseSuggestion(await res.json());
      const { best, confident } = pickBest(list, {
        titles,
        year,
        kinds: payload.kind === 'series' ? ['series', 'tvSeries'] : ['movie'],
      });
      const id = candidateImdbId(best);
      if (confident && id) return id;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// IMDb Top 250（电影榜 + 剧集榜）
// ---------------------------------------------------------------------------

const CHARTS = {
  movie: { url: 'https://www.imdb.com/chart/top/', bundled: TOP250 },
  tv: { url: 'https://www.imdb.com/chart/toptv/', bundled: TOP250_TV },
};

const chartStates = new Map();

/** 运行时刷新过的数据优先，没有就用内置快照。 */
async function readLiveCharts() {
  const live = await getCache('top250:live');
  if (!live || typeof live !== 'object') return {};
  // 兼容 1.2.0 的旧格式：{ items, updatedAt }，那时只有电影榜
  if (Array.isArray(live.items)) {
    return { movie: { items: live.items, updatedAt: live.updatedAt } };
  }
  return live;
}

async function getChartState(chart) {
  if (chartStates.has(chart)) return chartStates.get(chart);

  const cfg = CHARTS[chart];
  let items = cfg.bundled.items;
  let updatedAt = cfg.bundled.updatedAt;

  const entry = (await readLiveCharts())[chart];
  if (entry && Array.isArray(entry.items) && entry.items.length) {
    items = entry.items;
    updatedAt = entry.updatedAt || updatedAt;
  }

  const state = { chart, map: buildRankIndex(items), items, total: items.length, updatedAt };
  chartStates.set(chart, state);
  return state;
}

/** 先查对应类型的榜，再兜底查另一个（豆瓣偶尔把剧标成电影）。 */
async function getTop250Rank(imdbId, kind) {
  if (!imdbId) return null;
  const order = kind === 'series' ? ['tv', 'movie'] : ['movie', 'tv'];
  for (const chart of order) {
    const state = await getChartState(chart);
    const rank = state.map.get(imdbId);
    if (rank) return { rank, chart, total: state.total, updatedAt: state.updatedAt };
  }
  return null;
}

/** 数据源 1：直连 IMDb 榜单页（浏览器已通过 WAF 时可用）。 */
async function fetchChartFromImdb(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`IMDb ${res.status}`);
  return parseChartHtml(await res.text());
}

/** 数据源 2：Internet Archive 最近一份网页快照。 */
async function fetchChartFromArchive(url) {
  const key = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const cdx = await fetch(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(key)}&output=json&limit=-1&filter=statuscode:200&fl=timestamp`,
    { headers: { Accept: 'application/json' } }
  );
  if (!cdx.ok) throw new Error(`CDX ${cdx.status}`);
  const rows = await cdx.json();
  const timestamp = rows?.[1]?.[0];
  if (!timestamp) throw new Error('没有可用快照');

  const res = await fetch(`https://web.archive.org/web/${timestamp}id_/${url}`);
  if (!res.ok) throw new Error(`快照 ${res.status}`);
  return parseChartHtml(await res.text());
}

async function refreshTop250() {
  const live = await readLiveCharts();
  const charts = {};
  let anySuccess = false;

  for (const chart of Object.keys(CHARTS)) {
    const previous = await getChartState(chart);

    let items = null;
    for (const fn of [fetchChartFromImdb, fetchChartFromArchive]) {
      try {
        const parsed = await fn(CHARTS[chart].url);
        if (parsed && isValidTop250(parsed)) {
          items = parsed;
          break;
        }
      } catch {
        /* 换下一个数据源 */
      }
    }

    if (!items) {
      charts[chart] = { ok: false, total: previous.total, updatedAt: previous.updatedAt };
      continue;
    }

    const next = compact(items);
    const changed = JSON.stringify(next) !== JSON.stringify(previous.items);
    const updatedAt = changed ? new Date().toISOString().slice(0, 10) : previous.updatedAt;

    // 名次没变就不写 storage，避免每天无意义地改日期
    if (changed) {
      live[chart] = { items: next, updatedAt };
      chartStates.delete(chart);
    }

    charts[chart] = { ok: true, changed, total: next.length, updatedAt };
    anySuccess = true;
  }

  if (anySuccess) await setCache('top250:live', live, 30 * 24 * 60 * 60 * 1000);
  if (!anySuccess) {
    return { ok: false, code: 'TOP250_FAILED', message: '两个榜都没取到，稍后再试' };
  }
  return { ok: true, charts };
}

// ---------------------------------------------------------------------------
// 定时刷新
// ---------------------------------------------------------------------------

const TOP250_ALARM = 'dbimdb-top250';
const TOP250_MIN_INTERVAL = 20 * 60 * 60 * 1000; // 最快 20 小时一次

function ensureTop250Alarm() {
  if (!chrome.alarms) return;
  chrome.alarms.create(TOP250_ALARM, { delayInMinutes: 2, periodInMinutes: 24 * 60 });
}

/** 有节流地自动更新：失败也不会反复重试。 */
async function autoRefreshTop250() {
  const last = await getCache('top250:lastAttempt');
  const now = Date.now();
  if (last && now - last < TOP250_MIN_INTERVAL) return;

  await setCache('top250:lastAttempt', now, 7 * 24 * 60 * 60 * 1000);
  const result = await refreshTop250();
  if (result.ok) {
    const summary = Object.entries(result.charts)
      .map(([k, v]) => `${k}:${v.ok ? (v.changed ? '有变化' : '无变化') : '失败'}`)
      .join(' ');
    console.info(`[豆瓣 IMDb] Top 250 自动更新完成 ${summary}`);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function updateBadge(tabId, result) {
  const action = chrome.action;
  if (!action?.setBadgeText) return;
  if (result?.ok && result.data?.rating) {
    action.setBadgeBackgroundColor({ tabId, color: '#f5c518' }).catch(() => {});
    if (action.setBadgeTextColor) action.setBadgeTextColor({ tabId, color: '#111' }).catch(() => {});
    action.setBadgeText({ tabId, text: result.data.rating.toFixed(1) }).catch(() => {});
  } else {
    action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
}
