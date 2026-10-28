/**
 * 「直连 IMDb」模式（实验性，无需 API Key）。
 *
 * 两条路：
 *   1) 抓 https://www.imdb.com/title/ttXXXXXXX/ 页面，解析 JSON-LD 里的 aggregateRating；
 *   2) 直接调 IMDb 网站自己用的 GraphQL（api.graphql.imdb.com）。
 *
 * 现实情况：IMDb 对非浏览器请求有 AWS WAF 挑战（返回 202 + challenge.js），
 * GraphQL 还校验 Origin/Referer。所以这里两条路都可能失败——失败时由调用方
 * 引导用户去配置 OMDb Key。保留这个模块的意义是：它是「抓页面」这条思路的完整实现，
 * 在部分网络环境 / 浏览器已有 IMDb Cookie 时确实能拿到数据。
 */

export const IMDB_TITLE_PAGE = (id) => `https://www.imdb.com/title/${id}/`;
export const IMDB_SUGGEST = (q) =>
  `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json?includeVideos=0`;

export const RATING_QUERY = `query TitleRating($id: ID!) {
  title(id: $id) {
    id
    titleText { text }
    releaseYear { year }
    ratingsSummary { aggregateRating voteCount }
  }
}`;

/** 从 IMDb 建议接口（无需 Key、无 WAF）解析候选，用来把片名换成 tt id。 */
export function parseSuggestion(json) {
  const list = Array.isArray(json?.d) ? json.d : [];
  return list
    .filter((item) => /^tt\d{6,10}$/.test(String(item?.id || '')))
    .map((item) => ({
      imdbID: item.id,
      Title: item.l || '',
      Year: item.y ? String(item.y) : '',
      Type: item.qid || item.q || '',
      Poster: item.i?.imageUrl || null,
    }));
}

/** 解析 IMDb 标题页里的 JSON-LD（正常页面一定带一块）。 */
export function parseLdJson(html) {
  const text = String(html || '');
  const blocks = text.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const block of blocks) {
    let data;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const ar = node?.aggregateRating;
      if (!ar) continue;
      const rating = Number.parseFloat(ar.ratingValue);
      if (!Number.isFinite(rating)) continue;
      const votes = Number.parseInt(String(ar.ratingCount ?? ar.ratingCount), 10);
      return {
        rating,
        votes: Number.isFinite(votes) ? votes : null,
        bestRating: Number.parseFloat(ar.bestRating) || 10,
        title: node.name || '',
      };
    }
  }
  return null;
}

/** 兜底：新版 IMDb 是 Next.js，评分也出现在内嵌的 __NEXT_DATA__ 里。 */
export function parseNextData(html) {
  const text = String(html || '');
  const m = text.match(
    /"ratingsSummary"\s*:\s*\{\s*"aggregateRating"\s*:\s*([\d.]+)\s*,\s*"voteCount"\s*:\s*(\d+)/
  );
  if (!m) return null;
  const rating = Number.parseFloat(m[1]);
  if (!Number.isFinite(rating)) return null;
  return { rating, votes: Number.parseInt(m[2], 10) || null };
}

/** 从 GraphQL 响应里取评分。 */
export function parseGraphql(json) {
  const summary = json?.data?.title?.ratingsSummary;
  const rating = Number.parseFloat(summary?.aggregateRating);
  if (!Number.isFinite(rating)) return null;
  const votes = Number(summary?.voteCount);
  return {
    rating,
    votes: Number.isFinite(votes) ? votes : null,
    title: json?.data?.title?.titleText?.text || '',
  };
}

export class DirectError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DirectError';
    this.code = code;
  }
}

async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 第一条路：抓标题页 HTML，解析 JSON-LD / __NEXT_DATA__。 */
async function tryTitlePage(fetchImpl, imdbId, timeoutMs) {
  const res = await timedFetch(
    fetchImpl,
    IMDB_TITLE_PAGE(imdbId),
    {
      credentials: 'include', // 带上用户已通过 WAF 校验的 Cookie
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    timeoutMs
  );
  if (!res.ok) throw new DirectError('PAGE_HTTP_' + res.status, `IMDb 返回 ${res.status}`);
  const html = await res.text();
  const parsed = parseLdJson(html) || parseNextData(html);
  if (!parsed?.rating) throw new DirectError('NO_RATING', '页面里没有评分字段（可能被 WAF 挑战页替换）');
  return { rating: parsed.rating, votes: parsed.votes, title: parsed.title, source: 'IMDb 页面' };
}

/** 第二条路：直接调 IMDb 网站自己用的 GraphQL。 */
async function tryGraphql(fetchImpl, imdbId, timeoutMs) {
  const res = await timedFetch(
    fetchImpl,
    'https://api.graphql.imdb.com/',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/graphql-response+json',
        Origin: 'https://www.imdb.com',
        Referer: 'https://www.imdb.com/',
      },
      body: JSON.stringify({ query: RATING_QUERY, variables: { id: imdbId } }),
    },
    timeoutMs
  );
  if (!res.ok) throw new DirectError('GRAPHQL_HTTP_' + res.status, `GraphQL 返回 ${res.status}`);
  const parsed = parseGraphql(await res.json());
  if (!parsed?.rating) throw new DirectError('NO_RATING', 'GraphQL 没有返回评分');
  return { rating: parsed.rating, votes: parsed.votes, title: parsed.title, source: 'IMDb GraphQL' };
}

/**
 * 直连拿评分。两条路并发（谁先返回用谁），都失败就抛 DirectError。
 * @returns {Promise<{rating:number, votes:number|null, title?:string, source:string}>}
 */
export async function fetchDirectRating(imdbId, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 4000;

  try {
    return await Promise.any([
      tryTitlePage(fetchImpl, imdbId, timeoutMs),
      tryGraphql(fetchImpl, imdbId, timeoutMs),
    ]);
  } catch {
    throw new DirectError('DIRECT_BLOCKED', 'IMDb 拒绝了直连请求（AWS WAF 拦截）');
  }
}
