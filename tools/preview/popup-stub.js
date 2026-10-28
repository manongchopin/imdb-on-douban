/** popup 预览用桩：伪造 chrome.* ，让真实 popup.js 能跑起来。 */
(() => {
  const SETTINGS = { enabled: true, apiKey: 'a1b2c3d4', provider: 'auto', showVotes: true, showExtra: true };
  const TAB_STATE = {
    status: 'ok',
    data: { imdbId: 'tt0111161', rating: 9.3, votes: 3258937 },
    message: '',
    page: { title: '肖申克的救赎 The Shawshank Redemption', year: '1994', imdbId: 'tt0111161' },
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
