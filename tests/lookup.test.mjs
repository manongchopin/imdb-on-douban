/**
 * 端到端（无网络）验证 background 的 LOOKUP 流程：
 * 片名 → OMDb 搜索 → 挑选 → 取评分 → 写缓存 → 第二次命中缓存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const SETTINGS = { enabled: true, apiKey: 'testkey', provider: 'omdb', showVotes: true, showExtra: true };

const SEARCH_JSON = {
  Response: 'True',
  Search: [
    { Title: 'The Shawshank Redemption: Cast Interviews', Year: '2004', imdbID: 'tt5443390', Type: 'movie' },
    { Title: 'The Shawshank Redemption', Year: '1994', imdbID: 'tt0111161', Type: 'movie' },
  ],
};

const TITLE_JSON = {
  Response: 'True',
  Title: 'The Shawshank Redemption',
  Year: '1994',
  Type: 'movie',
  imdbRating: '9.3',
  imdbVotes: '3,258,937',
  imdbID: 'tt0111161',
  Ratings: [{ Source: 'Rotten Tomatoes', Value: '91%' }],
};

function makeStorage(initial = {}) {
  const memory = { ...initial };
  const pick = (keys) => {
    if (keys == null) return { ...memory };
    if (typeof keys === 'string') return keys in memory ? { [keys]: memory[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in memory) out[k] = memory[k];
      return out;
    }
    const out = {};
    for (const [k, fallback] of Object.entries(keys)) out[k] = k in memory ? memory[k] : fallback;
    return out;
  };
  return {
    memory,
    api: {
      get: async (keys) => pick(keys),
      set: async (items) => Object.assign(memory, items),
      remove: async (keys) => {
        for (const k of [].concat(keys)) delete memory[k];
      },
      clear: async () => {
        for (const k of Object.keys(memory)) delete memory[k];
      },
    },
  };
}

const local = makeStorage();
let messageListener = null;
let alarmListener = null;
const fetchLog = [];

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => (messageListener = fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
  },
  alarms: {
    onAlarm: { addListener: (fn) => (alarmListener = fn) },
    create: () => {},
    get: async () => undefined,
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setBadgeTextColor: async () => {},
  },
  storage: {
    local: local.api,
    sync: {
      get: async () => SETTINGS,
      set: async () => {},
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
};

globalThis.fetch = async (url) => {
  fetchLog.push(String(url));
  const params = new URL(String(url)).searchParams;
  const body = params.get('s')
    ? SEARCH_JSON
    : params.get('i') === 'tt0111161'
      ? TITLE_JSON
      : { Response: 'False', Error: 'Movie not found!' };
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

await import('../src/background.js');

function dispatch(message) {
  return new Promise((resolve) => messageListener(message, { tab: { id: 7 } }, resolve));
}

const PAGE = {
  doubanId: '1292052',
  titles: ['肖申克的救赎', 'The Shawshank Redemption', '月黑高飞'],
  year: '1994',
  kind: 'movie',
  imdbId: '',
};

test('LOOKUP 能从片名走到评分，并写入缓存', async () => {
  const res = await dispatch({ type: 'LOOKUP', payload: PAGE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.rating, 9.3);
  assert.equal(res.data.imdbId, 'tt0111161');
  assert.equal(res.data.votes, 3258937);
  assert.equal(res.prefs.showVotes, true);
  assert.equal(res.data.top250?.rank, 1, '肖申克应该是 Top 250 第 1 名');
  assert.ok(fetchLog.length >= 2, '应该至少请求搜索接口和详情接口');
});

test('第二次 LOOKUP 命中缓存，不再发请求', async () => {
  const before = fetchLog.length;
  const res = await dispatch({ type: 'LOOKUP', payload: PAGE });
  assert.equal(res.ok, true);
  assert.equal(res.cached, true);
  assert.equal(fetchLog.length, before);
});

test('页面自带 IMDb id 时跳过搜索，只请求详情', async () => {
  const before = fetchLog.length;
  const res = await dispatch({
    type: 'LOOKUP',
    payload: { ...PAGE, doubanId: '9999999', imdbId: 'tt0111161', titles: ['肖申克的救赎'] },
  });
  assert.equal(res.ok, true);
  assert.equal(res.cached, true, '同一部片应复用按 imdb id 的缓存');
  assert.equal(fetchLog.length, before);
});

test('没有 Key 时走直连，失败后给出可直接配置 Key 的错误码', async () => {
  SETTINGS.apiKey = '';
  SETTINGS.provider = 'auto';
  const res = await dispatch({
    type: 'LOOKUP',
    payload: { ...PAGE, doubanId: '8888888', titles: ['肖申克的救赎'], imdbId: '' },
  });
  assert.equal(res.ok, false);
  // 直连返回 WAF 挑战页（202/空 HTML）时会失败；也可能是建议接口没匹配到
  assert.ok(['DIRECT_BLOCKED', 'NO_MATCH'].includes(res.code), `实际 ${res.code}`);
});

test('直连失败后写「冷静期」，后续页面不再反复重试', async () => {
  SETTINGS.apiKey = '';
  SETTINGS.provider = 'auto';
  const payload = {
    ...PAGE,
    doubanId: '7777777',
    imdbId: 'tt1375666',
    titles: ['盗梦空间', 'Inception'],
  };

  const first = await dispatch({ type: 'LOOKUP', payload });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'DIRECT_BLOCKED');

  const before = fetchLog.length;
  const second = await dispatch({ type: 'LOOKUP', payload: { ...payload, doubanId: '6666666' } });
  assert.equal(second.code, 'DIRECT_BLOCKED');
  assert.equal(fetchLog.length, before, '冷静期内不应再发请求');
});

test('REFRESH_TOP250 在两个数据源都拿不到时返回失败码', async () => {
  const res = await dispatch({ type: 'REFRESH_TOP250' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TOP250_FAILED');
});

test('TOP250_STATUS 返回内置快照的日期和数量', async () => {
  const res = await dispatch({ type: 'TOP250_STATUS' });
  assert.equal(res.ok, true);
  assert.equal(res.total, 250);
  assert.match(res.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('Top 250 定时器会注册，并带有 20 小时节流', async () => {
  assert.equal(typeof alarmListener, 'function', '应注册 onAlarm 监听');

  alarmListener({ name: 'dbimdb-top250' });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(local.memory['dbimdb:cache:top250:lastAttempt'], '应记录本次尝试时间');

  const before = fetchLog.length;
  alarmListener({ name: 'dbimdb-top250' });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fetchLog.length, before, '20 小时内不应再次请求');

  // 不相干的 alarm 不应触发任何事情
  alarmListener({ name: 'something-else' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchLog.length, before);
});
