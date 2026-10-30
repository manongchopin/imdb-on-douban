#!/usr/bin/env node
/**
 * 生成 data/top100-chinese.js：IMDb 华语电影 Top 100（本站自己算的榜）。
 *
 *   node tools/build-chinese-top100.mjs
 *   node tools/build-chinese-top100.mjs --limit 30   # 只翻 30 页，调试用
 *
 * 规则（见 README「华语片 Top 100」）：
 *   1. 只取 IMDb 标记语言为 cmn/yue/zh/nan/wuu/hak 的 **电影**；
 *   2. 票数 ≥ 2000，避免"6 个人打 9.7 分"的冷门片霸榜；
 *   3. 用贝叶斯加权分排序（和 IMDb Top 250 同款公式）：
 *        score = (v/(v+m))·R + (m/(v+m))·C    m=2500，C=这批片子的平均分
 *   4. 取前 100。
 *
 * 数据源是 IMDb 网站自己用的 GraphQL（Node 里可以带 Origin 头，扩展里不行），
 * 所以这个榜只能在构建时算，跑完把结果写进 data/。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OUT = join(root, 'data', 'top100-chinese.js');
const EXCLUDES = join(here, 'chinese-exclusions.json');

const LANGS = ['cmn', 'yue', 'zh', 'nan', 'wuu', 'hak'];
const MIN_VOTES = 2000;
const M = 2500;
const TOP = 100;
const PER_PAGE = 250;

const argv = process.argv.slice(2);
const limitIdx = argv.indexOf('--limit');
const MAX_PAGES = limitIdx >= 0 ? Number(argv[limitIdx + 1]) || 10 : 80;

const ENDPOINT = 'https://api.graphql.imdb.com/';

const QUERY = `query($n: Int!, $after: String) {
  advancedTitleSearch(first: $n, after: $after, constraints: {
    titleTypeConstraint: { anyTitleTypeIds: ["movie"] },
    languageConstraint: { anyPrimaryLanguages: ${JSON.stringify(LANGS)} }
  }, sort: { sortBy: USER_RATING, sortOrder: DESC }) {
    total
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        title {
          id
          titleText { text }
          originalTitleText { text }
          releaseYear { year }
          ratingsSummary { aggregateRating voteCount }
        }
      }
    }
  }
}`;

async function gql(variables, attempt = 1) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.imdb.com',
        Referer: 'https://www.imdb.com/',
      },
      body: JSON.stringify({ query: QUERY, variables }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data.advancedTitleSearch;
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 1200 * attempt));
    return gql(variables, attempt + 1);
  }
}

function loadExcludes() {
  if (!existsSync(EXCLUDES)) return { ids: [], note: '' };
  try {
    return JSON.parse(readFileSync(EXCLUDES, 'utf8'));
  } catch {
    return { ids: [], note: '' };
  }
}

async function collect() {
  const pool = [];
  let after = null;
  let pages = 0;
  let total = 0;

  while (pages < MAX_PAGES) {
    const page = await gql({ n: PER_PAGE, after });
    pages += 1;
    total = page.total;

    for (const edge of page.edges) {
      const t = edge.node.title;
      const votes = t.ratingsSummary?.voteCount || 0;
      const rating = t.ratingsSummary?.aggregateRating;
      if (!rating || votes < MIN_VOTES) continue;
      pool.push({
        id: t.id,
        title: t.titleText?.text || t.originalTitleText?.text || '',
        year: t.releaseYear?.year ?? null,
        rating,
        votes,
      });
    }

    // 这个 feed 是按评分倒序的，用每页第一条的评分判断要不要继续翻
    const pageTop = page.edges[0]?.node?.title?.ratingsSummary?.aggregateRating ?? 0;
    process.stdout.write(
      `\r  已翻 ${pages} 页（评分降到 ${pageTop}），符合条件的 ${pool.length} 部…`
    );

    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;

    // 评分已经降到 6.5 以下：再往后的片子加权后不可能进前 100
    if (pageTop && pageTop < 6.5) break;
    if (pool.length >= 900) break;
  }
  process.stdout.write('\n');
  return { pool, pages, total };
}

function rank(pool, excludes) {
  const valid = pool.filter((item) => !excludes.has(item.id));
  const mean = valid.reduce((sum, item) => sum + item.rating, 0) / valid.length;

  const scored = valid.map((item) => {
    const v = item.votes;
    const score = (v / (v + M)) * item.rating + (M / (v + M)) * mean;
    return { ...item, score: Math.round(score * 1000) / 1000 };
  });

  scored.sort((a, b) => b.score - a.score || b.votes - a.votes);
  return scored.slice(0, TOP).map((item, index) => ({ ...item, rank: index + 1 }));
}

async function readExisting() {
  if (!existsSync(OUT)) return null;
  try {
    const mod = await import(`${pathToFileURL(OUT).href}?v=${Date.now()}`);
    return mod.CHINESE_TOP100?.items || null;
  } catch {
    return null;
  }
}

const excludeConfig = loadExcludes();
const excludes = new Set(excludeConfig.ids || []);
console.log(`抓取华语电影（票数 ≥ ${MIN_VOTES}）…`);
const { pool, pages, total } = await collect();
console.log(`  共 ${total} 部华语电影，翻 ${pages} 页，入选池 ${pool.length} 部`);

if (pool.length < TOP) {
  console.error(`符合条件的只有 ${pool.length} 部，不够 ${TOP} 条，放弃写入。`);
  process.exit(1);
}

const items = rank(pool, excludes);
const existing = await readExisting();
const same = existing && JSON.stringify(existing) === JSON.stringify(items);

if (same) {
  console.log('✓ 和现有文件一致，保持不动。');
  process.exit(0);
}

const payload = {
  updatedAt: new Date().toISOString().slice(0, 10),
  source: 'IMDb GraphQL advancedTitleSearch',
  rule: { minVotes: MIN_VOTES, m: M, method: 'bayesian' },
  total: items.length,
  items,
};

const body = `/**
 * IMDb 华语电影 Top 100 —— 由 tools/build-chinese-top100.mjs 生成，请勿手改。
 * 规则：语言为 cmn/yue/zh/nan/wuu/hak 的电影，票数 ≥ ${MIN_VOTES}，
 *       按贝叶斯加权分（m=${M}）排序取前 ${TOP}。
 * 生成时间：${payload.updatedAt}
 * 注意：这是本项目自己计算的榜，不是 IMDb 官方榜单。
 */
export const CHINESE_TOP100 = ${JSON.stringify(payload, null, 2)};
`;

writeFileSync(OUT, body);
console.log(`✓ 写入 data/top100-chinese.js：${items.length} 条`);
console.log('  前 5：');
for (const item of items.slice(0, 5)) {
  console.log(
    `    ${String(item.rank).padStart(3)}. ${item.title.slice(0, 24).padEnd(26)} ${item.year}  ${item.rating} (${item.votes.toLocaleString()})  → ${item.score}`
  );
}
console.log(`  平均分 C = ${(payload.items.reduce((s, i) => s + i.rating, 0) / items.length).toFixed(2)}`);
