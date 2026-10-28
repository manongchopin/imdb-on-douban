/** 配置项：存在 chrome.storage.sync，跨设备同步。 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  apiKey: '',
  provider: 'auto', // auto | omdb | direct
  showVotes: true,
  showExtra: true,
});

const AREA = 'sync';

export async function getSettings() {
  const stored = await chrome.storage[AREA].get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key in DEFAULTS) clean[key] = value;
  }
  if (typeof clean.apiKey === 'string') clean.apiKey = clean.apiKey.trim();
  await chrome.storage[AREA].set(clean);
  return getSettings();
}

/** 监听配置变化（返回取消订阅函数）。 */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== AREA) return;
    const keys = Object.keys(changes).filter((k) => k in DEFAULTS);
    if (!keys.length) return;
    getSettings().then(callback);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
