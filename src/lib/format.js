/** 展示层格式化工具（纯函数，可单测）。 */

/** 3258937 -> "325.9 万"；8600 -> "8,600"。 */
export function formatVotes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 100000000) return `${trimZero((n / 100000000).toFixed(1))} 亿`;
  if (n >= 10000) return `${trimZero((n / 10000).toFixed(1))} 万`;
  return n.toLocaleString('zh-CN');
}

/** 9 -> "9.0"；9.25 -> "9.3"。 */
export function formatRating(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toFixed(1);
}

function trimZero(s) {
  return s.replace(/\.0$/, '');
}

/** 豆瓣 h1 里 "肖申克的救赎 The Shawshank Redemption" -> { primary, latin }。 */
export function splitDoubanTitle(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { primary: '', latin: '' };
  const m = text.match(/^([\s\S]*?)\s+([A-Za-z][A-Za-z0-9\s:,'’\-.&!?()[\]]*)$/);
  if (m && m[1] && /[\u4e00-\u9fa5]/.test(m[1])) {
    return { primary: m[1].trim(), latin: m[2].trim() };
  }
  if (/^[A-Za-z]/.test(text) && !/[\u4e00-\u9fa5]/.test(text)) {
    return { primary: text, latin: text };
  }
  return { primary: text, latin: '' };
}

/** 去掉首尾括号和空白，例如 "(1994)" -> "1994"。 */
export function cleanYear(value) {
  const m = String(value || '').match(/(\d{4})/);
  return m ? m[1] : '';
}

/** 极简 HTML 转义，用于把外部字符串塞进 innerHTML。 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
