#!/usr/bin/env node
/**
 * 把 SVG 栅格化成扩展需要的 4 个尺寸 PNG。
 *
 *   node tools/make-icons.mjs
 *
 * 做法：用本机 Chrome 无头模式渲染 1024×1024 母版，再用 sips 缩小 —— 相当于
 * 4~64 倍超采样，比直接在小窗口里渲染干净得多（小尺寸渲染时 Chrome 会做
 * 奇怪的重排）。只依赖 macOS 自带的 Chrome 和 sips。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MASTER = 1024;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIPS = process.env.SIPS_PATH || '/usr/bin/sips';

if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}\n可用 CHROME_PATH 指定路径。`);
  process.exit(1);
}

const big = readFileSync(join(here, 'icon.svg'), 'utf8');
const small = readFileSync(join(here, 'icon-small.svg'), 'utf8');

const jobs = [
  { svg: big, size: 128, out: 'icon128.png' },
  { svg: big, size: 48, out: 'icon48.png' },
  { svg: small, size: 32, out: 'icon32.png' },
  { svg: small, size: 16, out: 'icon16.png' },
];

const tmp = mkdtempSync(join(tmpdir(), 'dbimdb-icons-'));
const profile = join(tmp, 'profile');

function renderMaster(svg, name) {
  const sized = svg
    .replace(/width="\d+"/, `width="${MASTER}"`)
    .replace(/height="\d+"/, `height="${MASTER}"`);
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style>
${sized}`;
  const page = join(tmp, `${name}.html`);
  const png = join(tmp, `${name}.png`);
  writeFileSync(page, html);
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      '--default-background-color=00000000',
      '--force-device-scale-factor=1',
      `--window-size=${MASTER},${MASTER}`,
      `--screenshot=${png}`,
      `file://${page}`,
    ],
    { stdio: 'ignore' }
  );
  return png;
}

const masterBig = renderMaster(big, 'master-big');
const masterSmall = renderMaster(small, 'master-small');

for (const job of jobs) {
  const master = job.svg === big ? masterBig : masterSmall;
  const out = join(outDir, job.out);
  execFileSync(SIPS, ['-z', String(job.size), String(job.size), master, '--out', out], {
    stdio: 'ignore',
  });
  console.log(`✓ icons/${job.out} (${job.size}×${job.size})`);
}

rmSync(tmp, { recursive: true, force: true });
