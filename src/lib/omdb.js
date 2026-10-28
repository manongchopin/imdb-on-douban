/**
 * OMDb API 封装（https://www.omdbapi.com）。
 *
 * 为什么用它：IMDb 官方页面现在有 AWS WAF 的 JS 挑战，扩展直接抓取成功率很低；
 * OMDb 是官方数据的镜像，免费 Key 每天 1000 次，足够个人使用。
 *
 * 这里只做「拼 URL / 解析响应 / 归一化错误码」，网络请求由调用方注入 fetch，
 * 这样既能跑在 Service Worker 里，也能在 Node 里做单元测试。
 */

export const OMDB_ENDPOINT = 'https://www.omdbapi.com/';
export const OMDB_SIGNUP_URL = 'https://www.omdbapi.com/apikey.aspx';

export class OmdbError extends Error {
  constructor(code, message, raw) {
    super(message || code);
    this.name = 'OmdbError';
    this.code = code;
    this.raw = raw;
  }
}

export function buildTitleUrl({ apiKey, imdbId, plot = 'short' }) {
  const url = new URL(OMDB_ENDPOINT);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('i', imdbId);
  url.searchParams.set('plot', plot);
  url.searchParams.set('r', 'json');
  return url.toString();
}

export function buildSearchUrl({ apiKey, query, year, type }) {
  const url = new URL(OMDB_ENDPOINT);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('s', query);
  if (year) url.searchParams.set('y', String(year));
  if (type) url.searchParams.set('type', type);
  url.searchParams.set('r', 'json');
  return url.toString();
}

/** 把 OMDb 的英文报错映射成前端可用的错误码。 */
export function mapOmdbError(message) {
  const m = String(message || '').toLowerCase();
  if (/invalid api key|no api key|key is invalid/.test(m)) return 'BAD_KEY';
  if (/request limit|limit reached|daily limit/.test(m)) return 'RATE_LIMIT';
  if (/not found|notfound|incorrect imdb id/.test(m)) return 'NOT_FOUND';
  if (/too many results/.test(m)) return 'TOO_MANY';
  return 'OMDB_ERROR';
}

export function parseVotes(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const EXTRA_LABELS = {
  'Rotten Tomatoes': '烂番茄',
  Metacritic: 'Metacritic',
};

/**
 * 把 OMDb 的 title 响应归一化成插件内部结构。
 * @param {object} json
 */
export function toRating(json) {
  if (!json || json.Response === 'False') {
    throw new OmdbError(mapOmdbError(json?.Error), json?.Error, json);
  }
  const imdbId = /^tt\d{6,10}$/.test(String(json.imdbID || '')) ? json.imdbID : null;
  const ratingNum = Number.parseFloat(json.imdbRating);

  const extras = (Array.isArray(json.Ratings) ? json.Ratings : [])
    .filter((r) => r && r.Source && r.Source !== 'Internet Movie Database' && r.Value && r.Value !== 'N/A')
    .map((r) => ({
      source: r.Source,
      label: EXTRA_LABELS[r.Source] || r.Source,
      value: r.Value,
      // "91%" -> "91%"；"82/100" -> "82"
      short: r.Value.includes('/') ? r.Value.split('/')[0] : r.Value,
    }));

  return {
    imdbId,
    title: json.Title || '',
    year: json.Year || '',
    type: json.Type || '',
    rating: Number.isFinite(ratingNum) ? ratingNum : null,
    votes: parseVotes(json.imdbVotes),
    poster: json.Poster && json.Poster !== 'N/A' ? json.Poster : null,
    url: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
    extras,
    source: 'OMDb',
    fetchedAt: Date.now(),
  };
}

export function parseSearch(json) {
  if (!json || json.Response === 'False') {
    const code = mapOmdbError(json?.Error);
    if (code === 'NOT_FOUND') return [];
    throw new OmdbError(code, json?.Error, json);
  }
  const list = Array.isArray(json.Search) ? json.Search : [];
  return list
    .filter((item) => /^tt\d{6,10}$/.test(String(item?.imdbID || '')))
    .map((item) => ({
      imdbID: item.imdbID,
      Title: item.Title,
      Year: item.Year,
      Type: item.Type,
      Poster: item.Poster,
    }));
}

/**
 * 带错误归一化的 fetch。
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 */
export async function requestOmdb(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new OmdbError('NETWORK', err?.message || 'network error', err);
  }
  if (res.status === 401) throw new OmdbError('BAD_KEY', 'HTTP 401', res.status);
  if (res.status === 429) throw new OmdbError('RATE_LIMIT', 'HTTP 429', res.status);
  if (!res.ok) throw new OmdbError('HTTP_' + res.status, `HTTP ${res.status}`, res.status);

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new OmdbError('BAD_RESPONSE', '响应不是合法 JSON', err);
  }
  if (json && json.Response === 'False') {
    throw new OmdbError(mapOmdbError(json.Error), json.Error, json);
  }
  return json;
}
