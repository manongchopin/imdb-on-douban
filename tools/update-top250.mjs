#!/usr/bin/env node
/**
 * 生成内置榜单快照：电影榜和剧集榜。
 *
 *   node tools/update-top250.mjs            # 两个榜都更新
 *   node tools/update-top250.mjs --movie    # 只更新电影 Top 250
 *   node tools/update-top250.mjs --tv       # 只更新剧集 Top 250
 *   node tools/update-top250.mjs --wayback  # 跳过直连，只走 Internet Archive
 *
 * 为什么要内置快照：IMDb 榜单页有 AWS WAF，扩展运行时不一定抓得到；
 * 内置一份才能在打开页面时立刻显示名次。数据没变化时不写文件，避免空提交。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseChartHtml, compact, isValidTop250 } from '../src/lib/top250.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const CHARTS = [
  {
    key: 'movie',
    label: '电影 Top 250',
    url: 'https://www.imdb.com/chart/top/',
    out: join(root, 'data', 'top250.js'),
    exportName: 'TOP250',
  },
  {
    key: 'tv',
    label: '剧集 Top 250',
    url: 'https://www.imdb.com/chart/toptv/',
    out: join(root, 'data', 'top250-tv.js'),
    exportName: 'TOP250_TV',
  },
];

const argv = process.argv.slice(2);
const only = argv.includes('--movie') ? 'movie' : argv.includes('--tv') ? 'tv' : null;
const onlyWayback = argv.includes('--wayback');

async function fetchDirect(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = parseChartHtml(await res.text());
  if (!items) throw new Error('页面里没找到 __NEXT_DATA__（大概率被 WAF 挑战页替换了）');
  return { items, source: 'imdb.com' };
}

async function fetchWayback(url) {
  const key = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const cdx = await fetch(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(key)}&output=json&limit=-1&filter=statuscode:200&fl=timestamp`,
    { headers: { Accept: 'application/json' } }
  );
  if (!cdx.ok) throw new Error(`CDX 返回 ${cdx.status}`);
  const rows = await cdx.json();
  const timestamp = rows?.[1]?.[0];
  if (!timestamp) throw new Error('Internet Archive 上没有可用快照');

  const res = await fetch(`https://web.archive.org/web/${timestamp}id_/${url}`);
  if (!res.ok) throw new Error(`快照返回 ${res.status}`);
  const items = parseChartHtml(await res.text());
  if (!items) throw new Error('快照里没找到 __NEXT_DATA__');
  return { items, source: `web.archive.org @ ${timestamp}` };
}

async function readExisting(chart) {
  if (!existsSync(chart.out)) return null;
  try {
    const mod = await import(`${pathToFileURL(chart.out).href}?v=${Date.now()}`);
    return Array.isArray(mod[chart.exportName]?.items) ? mod[chart.exportName] : null;
  } catch {
    return null;
  }
}

async function updateChart(chart) {
  console.log(`\n== ${chart.label} (${chart.url})`);

  const sources = onlyWayback ? [fetchWayback] : [fetchDirect, fetchWayback];
  let result = null;
  for (const fn of sources) {
    try {
      result = await fn(chart.url);
      break;
    } catch (err) {
      console.warn(`  ✗ ${fn.name}: ${err.message}`);
    }
  }

  if (!result) {
    console.error('  所有数据源都失败了，保留原文件不动。');
    return false;
  }
  if (!isValidTop250(result.items)) {
    console.error(`  数据校验没通过（${result.items.length} 条），不写入。`);
    return false;
  }

  const payload = {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: result.source,
    total: result.items.length,
    items: compact(result.items),
  };

  const existing = await readExisting(chart);
  if (existing && JSON.stringify(existing.items) === JSON.stringify(payload.items)) {
    console.log(`  ✓ 和现有文件一致（${payload.total} 条），保持不动。`);
    return true;
  }

  const body = `/**
 * IMDb ${chart.label} 内置快照 —— 由 tools/update-top250.mjs 生成，请勿手改。
 * 页面：${chart.url}
 * 生成时间：${payload.updatedAt}
 * 数据来源：${payload.source}
 */
export const ${chart.exportName} = ${JSON.stringify(payload, null, 2)};
`;
  writeFileSync(chart.out, body);
  console.log(
    `  ✓ 写入 ${chart.out.replace(root + '/', '')}：${payload.total} 条，来源 ${payload.source}`
  );
  console.log(
    `    第 1 名 ${payload.items[0].title}，第 ${payload.total} 名 ${payload.items.at(-1).title}`
  );
  return true;
}

let allOk = true;
for (const chart of CHARTS) {
  if (only && chart.key !== only) continue;
  allOk = (await updateChart(chart)) && allOk;
}

process.exit(allOk ? 0 : 1);
