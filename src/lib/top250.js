/**
 * IMDb Top 250 榜单：解析、索引、校验。
 *
 * 数据从 IMDb 榜单页的 __NEXT_DATA__ 里取 —— 结构是
 *   props.pageProps.pageData.chartTitles.edges[].{ currentRank, node{ id, titleText, releaseYear } }
 *
 * 纯函数，不依赖 chrome.*，方便单测和 tools/update-top250.mjs 复用。
 */

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

/** @returns {{rank:number,id:string,title:string,year:number|null}[] | null} */
export function parseChartHtml(html) {
  const m = String(html || '').match(NEXT_DATA_RE);
  if (!m) return null;

  let data;
  try {
    data = JSON.parse(m[1].trim());
  } catch {
    return null;
  }

  const edges = data?.props?.pageProps?.pageData?.chartTitles?.edges;
  if (!Array.isArray(edges) || !edges.length) return null;

  const items = [];
  for (const edge of edges) {
    const node = edge?.node || {};
    const id = String(node.id || '');
    if (!/^tt\d{6,10}$/.test(id)) continue;

    const rank = Number(edge?.currentRank ?? node.currentRank);
    if (!Number.isFinite(rank) || rank <= 0) continue;

    items.push({
      rank,
      id,
      title: node.titleText?.text || node.originalTitleText?.text || '',
      year: node.releaseYear?.year ?? null,
    });
  }

  items.sort((a, b) => a.rank - b.rank);
  return items.length ? items : null;
}

/** 生成 imdbId -> rank 的查找表。 */
export function buildRankIndex(items) {
  const map = new Map();
  for (const item of items || []) {
    if (item && item.id) map.set(item.id, item.rank);
  }
  return map;
}

export function findRank(items, imdbId) {
  if (!imdbId) return null;
  const hit = (items || []).find((item) => item.id === imdbId);
  return hit ? hit.rank : null;
}

/** 榜单是否可信：至少 200 条、名次不重复、从第 1 名开始。 */
export function isValidTop250(items) {
  if (!Array.isArray(items) || items.length < 200) return false;
  const ranks = items.map((item) => item.rank);
  if (ranks[0] !== 1) return false;
  if (new Set(ranks).size !== ranks.length) return false;
  const ids = items.map((item) => item.id);
  return new Set(ids).size === ids.length;
}

/** 去掉多余字段，只留展示需要的，减小体积。 */
export function compact(items) {
  return (items || []).map((item) => ({
    rank: item.rank,
    id: item.id,
    title: item.title,
    year: item.year,
  }));
}
