/**
 * 本地缓存：写在 chrome.storage.local，带 TTL。
 * 目的是减少 API 调用（OMDb 免费额度 1000 次/天），并让重复打开同一页秒开。
 */

const PREFIX = 'dbimdb:cache:';

export async function getCache(key, now = Date.now()) {
  const full = PREFIX + key;
  const bag = await chrome.storage.local.get(full);
  const record = bag[full];
  if (!record || typeof record !== 'object') return null;
  if (!record.exp || record.exp <= now) {
    await chrome.storage.local.remove(full);
    return null;
  }
  return record.value ?? null;
}

export async function setCache(key, value, ttlMs) {
  const full = PREFIX + key;
  const exp = Date.now() + (ttlMs || 0);
  await chrome.storage.local.set({ [full]: { value, exp } });
  return value;
}

export async function deleteCache(key) {
  await chrome.storage.local.remove(PREFIX + key);
}

export async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

/** 定期清掉过期项，避免 storage 越来越胖。 */
export async function pruneCache(now = Date.now()) {
  const all = await chrome.storage.local.get(null);
  const dead = Object.entries(all)
    .filter(([k, v]) => k.startsWith(PREFIX) && (!v || !v.exp || v.exp <= now))
    .map(([k]) => k);
  if (dead.length) await chrome.storage.local.remove(dead);
  return dead.length;
}
