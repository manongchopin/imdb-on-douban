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

const TTL_RATING = 7 * 24 * 60 * 60 * 1000;
const TTL_MAP = 30 * 24 * 60 * 60 * 1000;
const TTL_DIRECT = 24 * 60 * 60 * 1000;

/** 同一部片的并发请求合并，避免页面重绘时重复打 API。 */
const inflight = new Map();

chrome.runtime.onInstalled.addListener(() => {
  pruneCache().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  pruneCache().catch(() => {});
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

  const task = (useOmdb ? lookupViaOmdb(payload, apiKey) : lookupViaDirect(payload)).then((result) => {
    if (result.ok) {
      result.prefs = { showVotes: settings.showVotes, showExtra: settings.showExtra };
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
