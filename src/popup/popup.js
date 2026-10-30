/** 扩展弹窗：配置 OMDb Key、查看当前页面状态、清缓存。 */
'use strict';

const $ = (id) => document.getElementById(id);

let currentTab = null;

init().catch((err) => console.warn('[豆瓣 IMDb] 弹窗初始化失败', err));

async function init() {
  bindEvents();
  const settings = await fetchSettings();
  applySettings(settings);

  currentTab = await getActiveTab();
  await renderStatus(settings);
  await renderTop250Date();
}

function bindEvents() {
  $('saveKey').addEventListener('click', onSaveKey);
  $('apiKey').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onSaveKey();
  });

  for (const id of ['enabled', 'showVotes', 'showExtra']) {
    $(id).addEventListener('change', async () => {
      const patch = {};
      patch[id] = $(id).checked;
      await send({ type: 'SAVE_SETTINGS', patch });
      if (id === 'enabled') await renderStatus(await fetchSettings());
    });
  }

  $('refreshTop250').addEventListener('click', async () => {
    const btn = $('refreshTop250');
    const date = $('top250Date');
    btn.disabled = true;
    btn.textContent = '更新中';
    date.textContent = '…';
    try {
      const res = await send({ type: 'REFRESH_TOP250' });
      if (res && res.ok) {
        btn.textContent = '已更新';
        await renderTop250Date();
        await renderStatus(await fetchSettings());
      } else {
        btn.textContent = '更新失败';
        await renderTop250Date();
      }
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '更新';
      }, 2200);
    }
  });

  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    btn.disabled = true;
    try {
      await sendToTab({ type: 'REFRESH' });
      await new Promise((resolve) => setTimeout(resolve, 700));
      await renderStatus(await fetchSettings());
    } finally {
      btn.disabled = false;
    }
  });

  $('clearCache').addEventListener('click', async () => {
    const btn = $('clearCache');
    btn.disabled = true;
    try {
      const res = await send({ type: 'CLEAR_CACHE' });
      toast('已清除缓存', 'ok');
      if (res && typeof res.removed === 'number') {
        $('statusSub').textContent = `清掉 ${res.removed} 条缓存，下次打开会重新查询`;
      }
    } finally {
      btn.disabled = false;
      setTimeout(() => {
        btn.disabled = false;
      }, 300);
    }
  });
}

async function onSaveKey() {
  const input = $('apiKey');
  const key = input.value.trim();
  const btn = $('saveKey');

  if (!key) {
    toast('请先填入 Key', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = '验证中';
  toast('正在验证…', 'info');

  try {
    const test = await send({ type: 'TEST_KEY', apiKey: key });
    if (!test || !test.ok) {
      toast(keyError(test), 'error');
      return;
    }
    await send({ type: 'SAVE_SETTINGS', patch: { apiKey: key } });
    toast(`验证通过：${test.title} ${test.rating}`, 'ok');
    await renderStatus(await fetchSettings());
    if (currentTab) await sendToTab({ type: 'REFRESH' }).catch(() => {});
  } catch (err) {
    toast('保存失败：' + (err && err.message ? err.message : '未知错误'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

function keyError(result) {
  switch (result && result.code) {
    case 'BAD_KEY':
      return 'Key 无效，请检查是否复制完整';
    case 'RATE_LIMIT':
      return '该 Key 今日额度已用完';
    case 'NETWORK':
      return '连不上 omdbapi.com，请检查网络';
    default:
      return (result && result.message) || '验证失败，请稍后重试';
  }
}

// ---------------------------------------------------------------------------

async function renderStatus(settings) {
  const main = $('statusMain');
  const sub = $('statusSub');
  const box = $('status');

  if (!settings.enabled) {
    box.dataset.tone = 'idle';
    main.textContent = '插件已关闭';
    sub.textContent = '打开右上角开关即可启用';
    return;
  }

  if (!currentTab) {
    box.dataset.tone = 'idle';
    main.textContent = '无法读取当前标签页';
    sub.textContent = '';
    return;
  }

  if (!/^https?:\/\/movie\.douban\.com\/subject\//.test(currentTab.url || '')) {
    box.dataset.tone = 'idle';
    main.textContent = '当前页面不是豆瓣电影页';
    sub.textContent = '打开 movie.douban.com 的任意电影页面后再点这里';
    return;
  }

  let state = null;
  try {
    state = await sendToTab({ type: 'POPUP_STATE' });
  } catch {
    box.dataset.tone = 'warn';
    main.textContent = '页面还没加载插件脚本';
    sub.textContent = '刷新一下豆瓣页面即可生效';
    return;
  }

  if (!state) {
    box.dataset.tone = 'idle';
    main.textContent = '豆瓣页面信息读取中';
    sub.textContent = '稍后重试，或刷新页面';
    return;
  }

  const page = state.page || {};
  const title = [page.title, page.year ? `(${page.year})` : ''].filter(Boolean).join(' ');

  switch (state.status) {
    case 'ok': {
      const d = state.data || {};
      box.dataset.tone = 'ok';
      main.textContent = `IMDb ${Number(d.rating).toFixed(1)}`;
      const parts = [title, d.votes ? `${formatVotes(d.votes)} 人评分` : ''];
      if (d.top250 && d.top250.rank) {
        parts.push(
          d.top250.chart === 'tv' ? `TV Top 250 #${d.top250.rank}` : `Top 250 #${d.top250.rank}`
        );
      }
      if (d.chinese && d.chinese.rank) parts.push(`华语 #${d.chinese.rank}`);
      sub.textContent = parts.filter(Boolean).join(' · ');
      break;
    }
    case 'loading':
      box.dataset.tone = 'idle';
      main.textContent = '查询中…';
      sub.textContent = title;
      break;
    case 'need_key':
      box.dataset.tone = 'warn';
      main.textContent = '还没配置 OMDb Key';
      sub.textContent = '填入下方 Key 后即可显示 IMDb 评分';
      break;
    case 'no_match':
      box.dataset.tone = 'warn';
      main.textContent = '没找到匹配的 IMDb 条目';
      sub.textContent = title;
      break;
    case 'disabled':
      box.dataset.tone = 'idle';
      main.textContent = '插件已关闭';
      sub.textContent = '';
      break;
    default:
      box.dataset.tone = 'warn';
      main.textContent = '查询失败';
      sub.textContent = state.message || '稍后重试';
  }
}

function applySettings(settings) {
  $('enabled').checked = !!settings.enabled;
  $('apiKey').value = settings.apiKey || '';
  $('showVotes').checked = !!settings.showVotes;
  $('showExtra').checked = !!settings.showExtra;
}

async function renderTop250Date() {
  const res = await send({ type: 'TOP250_STATUS' });
  if (!res || !res.movie) {
    $('top250Date').textContent = '—';
    return;
  }
  const short = (value) => (value ? String(value).slice(5) : '—');
  $('top250Date').textContent = [
    `电影 ${short(res.movie.updatedAt)}`,
    `剧集 ${short(res.tv && res.tv.updatedAt)}`,
    res.chinese ? `华语 ${short(res.chinese.updatedAt)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

async function fetchSettings() {
  const res = await send({ type: 'GET_SETTINGS' });
  return (res && res.settings) || {
    enabled: true,
    apiKey: '',
    showVotes: true,
    showExtra: true,
    provider: 'auto',
  };
}

function toast(text, tone) {
  const el = $('keyMsg');
  el.hidden = false;
  el.textContent = text;
  el.dataset.tone = tone || 'info';
}

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch {
    return null;
  }
}

function sendToTab(message) {
  if (!currentTab || currentTab.id == null) return Promise.reject(new Error('no tab'));
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(currentTab.id, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}

function formatVotes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, '')} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万`;
  return n.toLocaleString('zh-CN');
}
