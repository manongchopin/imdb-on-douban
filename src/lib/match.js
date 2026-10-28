/**
 * 片名匹配：把豆瓣上的片名（中文名 / 原名 / 又名）与 OMDb 搜索结果做相似度打分，
 * 选出最可能是同一部片的条目。
 *
 * 纯函数，不依赖 chrome.* API，方便单元测试。
 */

const PUNCT = /[\s\u3000·・、,，.。:：;；!！?？'"“”‘’`()（）[\]【】<>《》\-–—_/\\|~～&+*#@%^$€£¥©®™]+/g;

/** 归一化片名：去音标、全角转半角、小写、去标点、去掉开头的冠词。 */
export function normalize(input) {
  if (!input) return '';
  let s = String(input);
  // NFKD 会把全角字符、带音标字符拆成基础字符
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[（(]\s*(19|20)\d{2}\s*[)）]/g, ' '); // 去掉片名里的年份
  s = s.replace(PUNCT, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^the\s+/, '');
  return s;
}

function bigrams(s) {
  const t = s.replace(/\s+/g, '');
  const out = [];
  if (t.length <= 1) return t ? [t] : [];
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

/** Dice 系数（基于字符二元组），对中英文都友好。 */
export function similarity(a, b) {
  const A = normalize(a);
  const B = normalize(b);
  if (!A || !B) return 0;
  if (A === B) return 1;

  const ga = bigrams(A);
  const gb = bigrams(B);
  if (!ga.length || !gb.length) return 0;

  const counter = new Map();
  for (const g of ga) counter.set(g, (counter.get(g) || 0) + 1);
  let inter = 0;
  for (const g of gb) {
    const c = counter.get(g);
    if (c) {
      inter += 1;
      counter.set(g, c - 1);
    }
  }
  let score = (2 * inter) / (ga.length + gb.length);

  // 包含关系（例如 "肖申克的救赎" vs "肖申克的救赎 4K 修复版"）给一点加成
  if (A.includes(B) || B.includes(A)) {
    const ratio = Math.min(A.length, B.length) / Math.max(A.length, B.length);
    score = Math.max(score, 0.55 + 0.45 * ratio);
  }
  return Math.min(1, score);
}

export function firstYear(value) {
  const m = String(value || '').match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

/**
 * 给一个候选条目打分。
 * @param {{Title?:string,title?:string,l?:string,Year?:string,y?:number,Type?:string,qid?:string,imdbID?:string,id?:string}} candidate
 * @param {{titles:string[], year:number|null, kinds:string[]}} target
 * @returns {{score:number, titleScore:number, reason:string}}
 */
export function scoreCandidate(candidate, target) {
  const names = [candidate.Title, candidate.title, candidate.l, candidate.originalTitle]
    .filter((v) => typeof v === 'string' && v.trim());
  const titles = (target.titles || []).filter(Boolean);

  let titleScore = 0;
  for (const name of names) {
    for (const t of titles) titleScore = Math.max(titleScore, similarity(t, name));
  }

  const candYear = firstYear(candidate.Year ?? candidate.y);
  let yearScore = 0.35; // 年份未知时给中性分，不要把候选直接判死
  if (candYear && target.year) {
    const diff = Math.abs(candYear - target.year);
    if (diff === 0) yearScore = 1;
    else if (diff === 1) yearScore = 0.6;
    else if (diff === 2) yearScore = 0.3;
    else yearScore = 0;
  } else if (candYear && !target.year) {
    yearScore = 0.5;
  }

  const type = String(candidate.Type || candidate.qid || '').toLowerCase();
  const kinds = target.kinds && target.kinds.length ? target.kinds : ['movie', 'series'];
  let typeScore = 0.6;
  if (type === 'episode') typeScore = 0.15;
  else if (kinds.includes(type)) typeScore = 1;
  else if (type) typeScore = 0.55;

  const score = titleScore * 70 + yearScore * 20 + typeScore * 10;
  return { score, titleScore, yearScore, typeScore, reason: `${titleScore.toFixed(2)}/${yearScore}/${typeScore}` };
}

/**
 * 从候选列表里挑出最佳匹配。
 * @returns {{best:object|null, score:number, confident:boolean}}
 */
export function pickBest(candidates, target, options = {}) {
  const minScore = options.minScore ?? 55;
  const minTitle = options.minTitle ?? 0.62;
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];

  let best = null;
  let bestScore = -1;
  let bestTitle = 0;
  let bestYear = 1;
  for (const cand of list) {
    const { score, titleScore, yearScore } = scoreCandidate(cand, target);
    if (score > bestScore) {
      bestScore = score;
      bestTitle = titleScore;
      bestYear = yearScore;
      best = cand;
    }
  }
  if (!best) return { best: null, score: 0, confident: false };
  // 年份差 3 年以上直接不信任：同名不同年的片子（如 1984/2021 两版《沙丘》）太多
  const confident = bestScore >= minScore && bestTitle >= minTitle && bestYear >= 0.3;
  return { best, score: bestScore, confident };
}

/** 从 OMDb / IMDb 建议接口的结果里取 imdb id。 */
export function candidateImdbId(candidate) {
  const raw = String(candidate?.imdbID || candidate?.id || '');
  return /^tt\d{6,10}$/.test(raw) ? raw : null;
}
