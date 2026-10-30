/** popup 预览用桩：伪造 chrome.* ，让真实 popup.js 能跑起来。 */
(() => {
  const SETTINGS = { enabled: true, apiKey: 'a1b2c3d4', provider: 'auto', showVotes: true, showExtra: true };
  const TAB_STATE = {
    status: 'ok',
    data: {
      imdbId: 'tt0106332',
      rating: 8.1,
      votes: 37943,
      chinese: { rank: 4, total: 100, updatedAt: '2026-10-30' },
    },
    message: '',
    page: { title: '霸王别姬 Farewell My Concubine', year: '1993', imdbId: 'tt0106332' },
  };

  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message, callback) {
        let response = { ok: true };
        if (message?.type === 'GET_SETTINGS') response = { ok: true, settings: SETTINGS };
        if (message?.type === 'SAVE_SETTINGS') Object.assign(SETTINGS, message.patch);
        if (message?.type === 'TEST_KEY') response = { ok: true, title: 'The Shawshank Redemption', rating: 9.3 };
        if (message?.type === 'CLEAR_CACHE') response = { ok: true, removed: 7 };
        if (message?.type === 'TOP250_STATUS') {
          response = {
            ok: true,
            movie: { total: 250, updatedAt: '2026-10-28' },
            tv: { total: 250, updatedAt: '2026-10-11' },
            chinese: { total: 100, updatedAt: '2026-10-30' },
          };
        }
        if (message?.type === 'REFRESH_TOP250') {
          response = {
            ok: true,
            charts: {
              movie: { ok: true, total: 250, updatedAt: '2026-10-28', changed: false },
              tv: { ok: true, total: 250, updatedAt: '2026-10-11', changed: false },
            },
          };
        }
        setTimeout(() => callback(response), 60);
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://movie.douban.com/subject/1292052/' }],
      sendMessage(_id, message, callback) {
        if (message?.type === 'POPUP_STATE') return callback(TAB_STATE);
        return callback({ ok: true });
      },
    },
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      sync: { get: async () => SETTINGS, set: async () => {} },
    },
  };
})();
