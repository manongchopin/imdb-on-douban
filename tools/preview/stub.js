/**
 * 仅用于本地预览卡片外观（不走真实网络）：伪造一个 chrome API，
 * 根据 ?state=ok|need_key|no_match|error|loading 返回不同结果。
 */
(() => {
  document.documentElement.setAttribute('data-dbimdb-preview', '1');
  const params = new URLSearchParams(location.search);
  const kind = params.get('state') || 'ok';

  // ?variant=cn：换成华语片（霸王别姬）的 DOM
  if (params.get('variant') === 'cn') {
    document.querySelector('[property="v:itemreviewed"]').textContent =
      '霸王别姬 Farewell My Concubine';
    document.querySelector('h1 .year').textContent = '(1993)';
    document.querySelector('#info').innerHTML = `
      <span><span class="pl">导演</span>: <span class="attrs"><a href="#">陈凯歌</a></span></span><br />
      <span class="pl">主演</span>: <span class="attrs"><a href="#">张国荣</a> / <a href="#">张丰毅</a></span><br />
      <span class="pl">类型:</span> 剧情 / 爱情 / 同性<br />
      <span class="pl">制片国家/地区:</span> 中国大陆 / 中国香港<br />
      <span class="pl">语言:</span> 汉语普通话<br />
      <span class="pl">上映日期:</span> 1993-01-01(中国香港)<br />
      <span class="pl">片长:</span> 171 分钟<br />
      <span class="pl">又名:</span> 再见，我的妾 / Adieu ma concubine<br />
      <span class="pl">IMDb:</span> tt0106332<br />`;
  }

  // ?variant=tv：换成电视剧页面的 DOM（有「集数」、IMDb 是链接、没有「上映日期」）
  if (params.get('variant') === 'tv') {
    document.querySelector('[property="v:itemreviewed"]').textContent =
      '绝命毒师 第一季 Breaking Bad Season 1';
    document.querySelector('h1 .year').textContent = '(2008)';
    document.querySelector('#info').innerHTML = `
      <span><span class="pl">导演</span>: <span class="attrs"><a href="#">文斯·吉利根</a></span></span><br />
      <span class="pl">主演</span>: <span class="attrs"><a href="#">布莱恩·科兰斯顿</a></span><br />
      <span class="pl">类型:</span> 剧情 / 犯罪<br />
      <span class="pl">集数:</span> 7<br />
      <span class="pl">首播:</span> 2008-01-20(美国)<br />
      <span class="pl">IMDb:</span> <a href="https://www.imdb.com/title/tt0903747/" target="_blank">tt0903747</a><br />`;
  }

  const FIXTURES = {
    ok: {
      ok: true,
      data: {
        imdbId: 'tt0111161',
        title: 'The Shawshank Redemption',
        year: '1994',
        rating: 9.3,
        votes: 3258937,
        url: 'https://www.imdb.com/title/tt0111161/',
        extras: [
          { source: 'Rotten Tomatoes', label: '烂番茄', short: '91%' },
          { source: 'Metacritic', label: 'Metacritic', short: '82' },
        ],
        source: 'OMDb',
        top250: {
          rank: 1,
          total: 250,
          chart: params.get('variant') === 'tv' ? 'tv' : 'movie',
          updatedAt: params.get('variant') === 'tv' ? '2026-10-11' : '2026-10-28',
        },
      },
      prefs: { showVotes: true, showExtra: true },
    },
    need_key: { ok: false, code: 'NEED_KEY' },
    no_match: { ok: false, code: 'NO_MATCH' },
    error: { ok: false, code: 'NETWORK', message: '连不上 omdbapi.com，请检查网络或代理' },
    disabled: { ok: false, code: 'DISABLED' },
  };

  if (params.get('variant') === 'cn') {
    FIXTURES.ok.data = {
      imdbId: 'tt0106332',
      title: 'Farewell My Concubine',
      year: '1993',
      rating: 8.1,
      votes: 37943,
      url: 'https://www.imdb.com/title/tt0106332/',
      extras: [],
      source: 'OMDb',
      chinese: { rank: 4, total: 100, updatedAt: '2026-10-30' },
    };
  }

  window.chrome = {
    runtime: {
      id: 'preview',
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message, callback) {
        const reply = (value) => setTimeout(() => callback(value), 400);
        if (message && message.type === 'LOOKUP') {
          window.__dbimdbCaptured = message.payload;
          return reply(FIXTURES[kind] || FIXTURES.ok);
        }
        if (message && message.type === 'TEST_KEY') {
          return reply({ ok: true, title: 'The Shawshank Redemption', rating: 9.3 });
        }
        return reply({ ok: true });
      },
    },
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      sync: { get: async () => ({}), set: async () => {} },
    },
  };
})();
