#!/usr/bin/env node
/**
 * 生成 data/top250.js（内置榜单快照）。
 *
 *   node tools/update-top250.mjs            # 直连 IMDb，失败时退回 Internet Archive
 *   node tools/update-top250.mjs --wayback  # 只用 Internet Archive
 *
 * 之所以要有快照：IMDb 的榜单页有 AWS WAF，扩展在运行时不一定抓得到；
 * 内置一份快照才能做到「打开页面立刻显示名次」。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseChartHtml, compact, isValidTop250 } from '../src/lib/top250.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OUT = join(root, 'data', 'top250.js');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

async function fetchDirect() {
  const res = await fetch('https://www.imdb.com/chart/top/', {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`IMDb 返回 ${res.status}`);
  const html = await res.text();
  const items = parseChartHtml(html);
  if (!items) throw new Error('页面里没找到 __NEXT_DATA__（大概率被 WAF 挑战页替换了）');
  return { items, source: 'imdb.com' };
}

async function fetchWayback() {
  const cdx = await fetch(
    'http://web.archive.org/cdx/search/cdx?url=imdb.com/chart/top&output=json&limit=-1&filter=statuscode:200&fl=timestamp',
    { headers: { Accept: 'application/json' } }
  );
  if (!cdx.ok) throw new Error(`CDX 返回 ${cdx.status}`);
  const rows = await cdx.json();
  const timestamp = rows?.[1]?.[0];
  if (!timestamp) throw new Error('Internet Archive 上没有可用快照');

  const res = await fetch(
    `https://web.archive.org/web/${timestamp}id_/https://www.imdb.com/chart/top/`
  );
  if (!res.ok) throw new Error(`快照返回 ${res.status}`);
  const html = await res.text();
  const items = parseChartHtml(html);
  if (!items) throw new Error('快照里没找到 __NEXT_DATA__');
  return { items, source: `web.archive.org @ ${timestamp}` };
}

const sources = process.argv.includes('--wayback')
  ? [fetchWayback]
  : [fetchDirect, fetchWayback];

let result = null;
for (const fn of sources) {
  try {
    console.log(`→ 尝试 ${fn.name} …`);
    result = await fn();
    break;
  } catch (err) {
    console.warn(`  ✗ ${err.message}`);
  }
}

if (!result) {
  console.error('所有数据源都失败了，保留原文件不动。');
  process.exit(1);
}

if (!isValidTop250(result.items)) {
  console.error(`数据校验没通过（${result.items.length} 条），不写入。`);
  process.exit(1);
}

const payload = {
  updatedAt: new Date().toISOString().slice(0, 10),
  source: result.source,
  total: result.items.length,
  items: compact(result.items),
};

// 名次没变化就不动文件，免得每周产生一个空提交
if (existsSync(OUT)) {
  try {
    const current = await import(`${pathToFileURL(OUT).href}?v=${Date.now()}`);
    if (JSON.stringify(current.TOP250.items) === JSON.stringify(payload.items)) {
      console.log('✓ 榜单和现有文件一致，保持不动。');
      process.exit(0);
    }
  } catch {
    /* 读不出来就照常覆盖 */
  }
}

const body = `/**
 * IMDb Top 250 内置快照 —— 由 tools/update-top250.mjs 生成，请勿手改。
 * 生成时间：${payload.updatedAt}
 * 数据来源：${payload.source}
 */
export const TOP250 = ${JSON.stringify(payload, null, 2)};
`;

writeFileSync(OUT, body);
console.log(`✓ 写入 data/top250.js：${payload.total} 条，来源 ${payload.source}`);
console.log(`  第 1 名 ${payload.items[0].title}，第 ${payload.total} 名 ${payload.items.at(-1).title}`);
