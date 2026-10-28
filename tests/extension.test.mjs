import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('manifest 是 MV3，且权限收敛', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.version && manifest.description);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'storage']);
  assert.equal(manifest.background.type, 'module');
  assert.ok(manifest.background.service_worker.endsWith('.js'));
});

test('content script 只注入豆瓣电影页', () => {
  const [script] = manifest.content_scripts;
  assert.ok(script.matches.includes('https://movie.douban.com/subject/*'));
  assert.ok(script.js.includes('src/content/content.js'));
  assert.ok(script.css.includes('src/content/content.css'));
});

test('manifest 引用的文件全部存在', () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((s) => [...s.js, ...s.css]),
  ];
  for (const file of files) {
    assert.ok(existsSync(join(root, file)), `缺少文件：${file}`);
  }
});

test('host_permissions 覆盖所有会用到的域名', () => {
  const hosts = manifest.host_permissions.join(' ');
  for (const domain of ['omdbapi.com', 'imdb.com', 'api.graphql.imdb.com', 'v3.sg.media-imdb.com', 'web.archive.org']) {
    assert.ok(hosts.includes(domain), `缺少 ${domain} 的 host 权限`);
  }
});

test('background.js 能在 chrome API 存在时加载并注册消息监听', async () => {
  const listeners = { message: 0, installed: 0, startup: 0 };
  const memory = {};
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: () => (listeners.message += 1) },
      onInstalled: { addListener: () => (listeners.installed += 1) },
      onStartup: { addListener: () => (listeners.startup += 1) },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys === null || keys === undefined) return { ...memory };
          if (typeof keys === 'string') return keys in memory ? { [keys]: memory[keys] } : {};
          return { ...memory };
        },
        set: async (items) => Object.assign(memory, items),
        remove: async (keys) => {
          for (const k of [].concat(keys)) delete memory[k];
        },
      },
      sync: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };

  await import('../src/background.js');
  assert.equal(listeners.message, 1);
  assert.equal(listeners.installed, 1);
  assert.equal(listeners.startup, 1);
});
