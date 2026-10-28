/**
 * Content script：只负责「读豆瓣页面 + 画卡片 + 转发消息」，不发任何网络请求。
 *
 * 因为 content script 不支持 ES Module，这里的几个格式化函数与
 * src/lib/format.js 是重复实现（构建系统为零，换取加载可靠性）。
 */
(() => {
  'use strict';

  if (window.__dbimdbInjected) return;
  window.__dbimdbInjected = true;

  const CARD_ID = 'dbimdb-card';
  const SIGNUP_URL = 'https://www.omdbapi.com/apikey.aspx';

  const state = {
    page: null,
    status: 'loading', // loading | ok | need_key | no_match | error | disabled
    data: null,
    message: '',
    busy: false,
  };

  boot().catch((err) => console.warn('[豆瓣 IMDb] 初始化失败', err));

  async function boot() {
    // 只处理「一部电影 / 一部剧」的主页，跳过 /subject/123/photos 这类子页面。
    // data-dbimdb-preview 是 tools/preview 里本地预览用的开关。
    const isPreview = document.documentElement.hasAttribute('data-dbimdb-preview');
    if (!isPreview && !/^\/subject\/\d+\/?$/.test(location.pathname)) return;

    const page = await readPageWhenReady();
    if (!page) return;
    state.page = page;

    mountCard();
    render();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (['apiKey', 'enabled', 'showVotes', 'showExtra', 'provider'].some((k) => k in changes)) {
        refresh();
      }
    });

    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (!message) return false;
      if (message.type === 'POPUP_STATE') {
        respond(summary());
        return false;
      }
      if (message.type === 'REFRESH') {
        refresh();
        respond({ ok: true });
        return false;
      }
      return false;
    });

    refresh();
  }

  // -------------------------------------------------------------------------
  // 读取豆瓣页面
  // -------------------------------------------------------------------------

  async function readPageWhenReady() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const page = readPage();
      if (page) return page;
      await sleep(200);
    }
    return null;
  }

  function readPage() {
    const titleEl =
      document.querySelector('#content h1 [property="v:itemreviewed"]') ||
      document.querySelector('h1 [property="v:itemreviewed"]');
    const info = document.querySelector('#info');
    if (!titleEl || !info) return null;

    const rawTitle = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
    const { primary, latin } = splitDoubanTitle(rawTitle);
    const yearEl = document.querySelector('#content h1 .year') || document.querySelector('h1 .year');
    const lines = infoLines(info);

    const year = cleanYear(yearEl && yearEl.textContent) || yearFromLines(lines);
    const aliases = aliasesFromLines(lines);
    const imdbId = imdbIdFromInfo(info);
    const kind = lines.some((line) => /^集数[:：]/.test(line)) ? 'series' : 'movie';
    const titles = withVariants([latin, primary, ...aliases]);

    return {
      doubanId: (location.pathname.match(/\/subject\/(\d+)/) || [])[1] || '',
      url: location.href.split('?')[0],
      rawTitle,
      titles,
      year,
      kind,
      imdbId,
      imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : '',
    };
  }

  /** 把 #info 的 <br> 换成换行，得到逐行文本，比直接啃 DOM 稳。 */
  function infoLines(info) {
    const clone = info.cloneNode(true);
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    return clone.textContent
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  function aliasesFromLines(lines) {
    const line = lines.find((l) => /^又名[:：]/.test(l));
    if (!line) return [];
    return line
      .replace(/^又名[:：]/, '')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  function yearFromLines(lines) {
    const line = lines.find((l) => /^(上映日期|首播|年份)[:：]/.test(l));
    if (!line) return '';
    const m = line.match(/(19|20)\d{2}/);
    return m ? m[0] : '';
  }

  function imdbIdFromInfo(info) {
    const fromText = (info.textContent || '').match(/tt\d{6,10}/);
    if (fromText) return fromText[0];
    const anchor = info.querySelector('a[href*="imdb.com/title/"]');
    const fromHref = anchor && anchor.getAttribute('href').match(/tt\d{6,10}/);
    return fromHref ? fromHref[0] : '';
  }

  // -------------------------------------------------------------------------
  // 卡片
  // -------------------------------------------------------------------------

  function mountCard() {
    if (document.getElementById(CARD_ID)) return;
    const card = document.createElement('div');
    card.id = CARD_ID;
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');

    const ratingBox = document.querySelector('#interest_sectl');
    const info = document.querySelector('#info');

    if (ratingBox && ratingBox.parentNode) {
      ratingBox.parentNode.insertBefore(card, ratingBox.nextSibling);
    } else if (info && info.parentNode) {
      info.parentNode.insertBefore(card, info.nextSibling);
    } else {
      return;
    }
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    state.status = 'loading';
    state.message = '';
    render();

    try {
      const result = await send({ type: 'LOOKUP', payload: state.page });
      if (result && result.ok) {
        state.status = 'ok';
        state.data = result.data;
        state.prefs = result.prefs || state.prefs;
      } else {
        state.data = null;
        state.status = mapStatus(result && result.code);
        state.message = (result && result.message) || '';
      }
    } catch (err) {
      state.status = 'error';
      state.message = isContextInvalid(err) ? '插件已更新，请刷新页面' : '扩展后台无响应，请刷新页面';
    } finally {
      state.busy = false;
      render();
    }
  }

  function mapStatus(code) {
    switch (code) {
      case 'NEED_KEY':
      case 'NO_KEY':
        return 'need_key';
      case 'BAD_KEY':
      case 'RATE_LIMIT':
        return 'need_key';
      case 'DISABLED':
        return 'disabled';
      case 'NO_MATCH':
        return 'no_match';
      case 'DIRECT_BLOCKED':
        return 'need_key';
      case 'NOT_FOUND':
        return 'no_match';
      default:
        return 'error';
    }
  }

  function summary() {
    return {
      status: state.status,
      data: state.data,
      message: state.message,
      page: state.page
        ? { title: state.page.rawTitle, year: state.page.year, imdbId: state.page.imdbId }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  function render() {
    const card = document.getElementById(CARD_ID);
    if (!card) return;
    card.dataset.state = state.status;
    card.innerHTML = markup();
    bind(card);
  }

  function markup() {
    if (state.status === 'loading') return loadingMarkup();
    if (state.status === 'ok') return okMarkup();
    if (state.status === 'need_key') return needKeyMarkup();
    if (state.status === 'no_match') return noMatchMarkup();
    if (state.status === 'disabled') return noticeMarkup('插件已关闭', '可在扩展弹窗里重新开启。');
    return errorMarkup();
  }

  function loadingMarkup() {
    return `
      <div class="dbimdb-head">
        <span class="dbimdb-logo">IMDb</span>
        <span class="dbimdb-skeleton dbimdb-skeleton-score"></span>
        <span class="dbimdb-skeleton dbimdb-skeleton-text"></span>
      </div>
      <div class="dbimdb-sub">正在查询 IMDb 评分…</div>`;
  }

  function okMarkup() {
    const d = state.data || {};
    const prefs = state.prefs || { showVotes: true, showExtra: true };
    const votes = d.votes && prefs.showVotes ? `${formatVotes(d.votes)} 人评分` : '';
    const extras = (d.extras || []).filter((e) => e && e.short);
    const showExtras = extras.length > 0 && prefs.showExtra !== false;
    const jump = d.url || state.page?.imdbUrl || '';

    return `
      <div class="dbimdb-head">
        <span class="dbimdb-logo">IMDb</span>
        <span class="dbimdb-score">${escapeHtml(formatRating(d.rating))}</span>
        ${votes ? `<span class="dbimdb-votes">${escapeHtml(votes)}</span>` : ''}
        ${
          jump
            ? `<a class="dbimdb-jump" href="${escapeHtml(jump)}" target="_blank" rel="noopener noreferrer" title="在 IMDb 查看">↗</a>`
            : ''
        }
      </div>
      ${
        showExtras
          ? `<div class="dbimdb-extras">${extras
              .map(
                (e) =>
                  `<span class="dbimdb-chip" title="${escapeHtml(e.source)}">${escapeHtml(e.label)} ${escapeHtml(
                    e.short
                  )}</span>`
              )
              .join('')}<span class="dbimdb-src">${escapeHtml(d.source || 'OMDb')}</span></div>`
          : `<div class="dbimdb-src dbimdb-src-alone">${escapeHtml(d.source || 'OMDb')}</div>`
      }`;
  }

  function needKeyMarkup() {
    const reason = state.message ? `<div class="dbimdb-sub">${escapeHtml(state.message)}</div>` : '';
    return `
      <div class="dbimdb-head">
        <span class="dbimdb-logo">IMDb</span>
        <span class="dbimdb-title">显示 IMDb 评分</span>
      </div>
      ${reason}
      <p class="dbimdb-desc">IMDb 官网会拦截插件直接抓取，需要一个免费的 OMDb Key（每天 1000 次，够用）。</p>
      <ol class="dbimdb-steps">
        <li><a href="${SIGNUP_URL}" target="_blank" rel="noopener noreferrer">打开申请页</a>，选 FREE，填邮箱</li>
        <li>点邮件里的激活链接，拿到 Key</li>
        <li>粘贴到下面</li>
      </ol>
      <form class="dbimdb-form">
        <input class="dbimdb-input" type="text" placeholder="粘贴 OMDb API Key" autocomplete="off" spellcheck="false" />
        <button class="dbimdb-btn" type="submit">保存</button>
      </form>
      <div class="dbimdb-feedback" hidden></div>`;
  }

  function noMatchMarkup() {
    const q = encodeURIComponent(state.page?.rawTitle || '');
    return `
      <div class="dbimdb-head">
        <span class="dbimdb-logo">IMDb</span>
        <span class="dbimdb-title">没找到匹配的条目</span>
      </div>
      <p class="dbimdb-desc">可能是冷门片或片名差异过大，可以手动去 IMDb 搜一下。</p>
      <div class="dbimdb-actions">
        <a class="dbimdb-btn dbimdb-btn-ghost" href="https://www.imdb.com/find/?q=${q}" target="_blank" rel="noopener noreferrer">去 IMDb 搜索</a>
        <button class="dbimdb-btn dbimdb-btn-ghost" type="button" data-action="retry">重试</button>
      </div>`;
  }

  function errorMarkup() {
    return `
      <div class="dbimdb-head">
        <span class="dbimdb-logo">IMDb</span>
        <span class="dbimdb-title">查询失败</span>
      </div>
      <p class="dbimdb-desc">${escapeHtml(state.message || '网络异常，请稍后再试。')}</p>
      <div class="dbimdb-actions">
        <button class="dbimdb-btn dbimdb-btn-ghost" type="button" data-action="retry">重试</button>
        <button class="dbimdb-btn dbimdb-btn-ghost" type="button" data-action="setup">配置 Key</button>
      </div>`;
  }

  function noticeMarkup(title, desc) {
    return `
      <div class="dbimdb-head">
        <span class="dbimdb-logo">IMDb</span>
        <span class="dbimdb-title">${escapeHtml(title)}</span>
      </div>
      <p class="dbimdb-desc">${escapeHtml(desc)}</p>`;
  }

  function bind(card) {
    card.querySelectorAll('[data-action="retry"]').forEach((btn) =>
      btn.addEventListener('click', () => refresh())
    );
    card.querySelectorAll('[data-action="setup"]').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.status = 'need_key';
        render();
      })
    );

    const form = card.querySelector('.dbimdb-form');
    if (form) form.addEventListener('submit', onSaveKey);
  }

  async function onSaveKey(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.querySelector('.dbimdb-input');
    const button = form.querySelector('.dbimdb-btn');
    const feedback = document.querySelector(`#${CARD_ID} .dbimdb-feedback`);
    const key = (input.value || '').trim();

    const say = (text, tone) => {
      if (!feedback) return;
      feedback.hidden = false;
      feedback.textContent = text;
      feedback.dataset.tone = tone || 'error';
    };

    if (!key) {
      say('请先粘贴 Key');
      return;
    }

    button.disabled = true;
    button.textContent = '验证中';
    say('正在验证…', 'info');

    try {
      const test = await send({ type: 'TEST_KEY', apiKey: key });
      if (!test || !test.ok) {
        say(keyErrorMessage(test), 'error');
        return;
      }
      await send({ type: 'SAVE_SETTINGS', patch: { apiKey: key } });
      say(`验证通过：${test.title} ${test.rating}`, 'ok');
      state.busy = false;
      refresh();
    } catch {
      say('保存失败，请刷新页面后重试');
    } finally {
      button.disabled = false;
      button.textContent = '保存';
    }
  }

  function keyErrorMessage(result) {
    switch (result && result.code) {
      case 'BAD_KEY':
        return 'Key 无效，请检查是否复制完整';
      case 'RATE_LIMIT':
        return '这个 Key 今天的额度用完了';
      case 'NETWORK':
        return '连不上 omdbapi.com，检查网络或代理';
      default:
        return (result && result.message) || '验证失败，请稍后再试';
    }
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  function send(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function isContextInvalid(err) {
    return /context invalidated|Receiving end does not exist/i.test(String(err && err.message));
  }

  function splitDoubanTitle(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return { primary: '', latin: '' };
    const m = text.match(/^([\s\S]*?)\s+([A-Za-z][A-Za-z0-9\s:,'’\-.&!?()[\]]*)$/);
    if (m && m[1] && /[\u4e00-\u9fa5]/.test(m[1])) {
      return { primary: m[1].trim(), latin: m[2].trim() };
    }
    if (!/[\u4e00-\u9fa5]/.test(text)) return { primary: text, latin: text };
    return { primary: text, latin: '' };
  }

  function cleanYear(value) {
    const m = String(value || '').match(/(\d{4})/);
    return m ? m[1] : '';
  }

  /** 剧集页常带「第二季 / Season 2」后缀，搜索时先补一个去掉后缀的版本。 */
  function withVariants(list) {
    const out = [];
    for (const item of list) {
      const title = String(item || '').trim();
      if (!title) continue;
      out.push(title);
      const stripped = title
        .replace(/\s*[:：]?\s*(season\s*\d+|第\s*[一二三四五六七八九十百\d]+\s*季)\s*$/i, '')
        .trim();
      if (stripped && stripped !== title) out.push(stripped);
    }
    return unique(out);
  }

  function unique(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const key = String(item || '').trim();
      if (!key) continue;
      const lower = key.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(key);
    }
    return out;
  }

  function formatRating(n) {
    return Number.isFinite(n) && n > 0 ? n.toFixed(1) : '';
  }

  function formatVotes(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, '')} 亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万`;
    return n.toLocaleString('zh-CN');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
