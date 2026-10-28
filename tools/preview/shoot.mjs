#!/usr/bin/env node
/**
 * 用 CDP 给「真实页面 + 假 chrome API」截图，用来做纯本地的视觉回归。
 *
 *   node tools/preview/shoot.mjs --url file://.../src/popup/popup.html \
 *     --stub tools/preview/popup-stub.js --out /tmp/popup.png --size 340x660
 *
 * 为什么不用 chrome --screenshot：新版 headless Chrome 已经不加载扩展了，
 * popup / content script 里对 chrome.* 的调用会直接抛错。这里在页面脚本执行
 * 之前注入一个桩对象（Page.addScriptToEvaluateOnNewDocument）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const args = { size: '340x660', settle: 900, port: 9333 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  if (!args.url || !args.out) {
    console.error('需要 --url 和 --out');
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [width, height] = args.size.split('x').map(Number);

if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'dbimdb-shoot-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-background-networking',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${args.port}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${args.port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('Chrome 调试端口没有起来');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const fn of this.handlers.get(msg.method)) fn(msg.params);
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs);
      const list = this.handlers.get(method) || [];
      const fn = (params) => {
        clearTimeout(timer);
        this.handlers.set(
          method,
          (this.handlers.get(method) || []).filter((f) => f !== fn)
        );
        resolve(params);
      };
      this.handlers.set(method, [...list, fn]);
    });
  }
}

try {
  const browserWs = await waitForDevtools();
  const browserUrl = new URL(browserWs);
  const targetRes = await fetch(`http://127.0.0.1:${args.port}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  });
  const target = await targetRes.json();
  void browserUrl;

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  if (args.stub && existsSync(args.stub)) {
    const source = readFileSync(args.stub, 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: Number(args.scale || 2),
    mobile: false,
  });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: args.url });
  await loaded.catch(() => {});
  await sleep(Number(args.settle));

  if (args.eval) {
    const out = await cdp.send('Runtime.evaluate', {
      expression: args.eval,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(JSON.stringify(out.result?.value ?? out.result, null, 2));
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(args.out, Buffer.from(shot.data, 'base64'));
  console.log(`✓ ${args.out} (${width * Number(args.scale || 2)}×${height * Number(args.scale || 2)})`);
} finally {
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
