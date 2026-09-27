/**
 * Eval metrics (dev only, not shipped): spelling-insensitive word comparison and word error rate.
 */

// Spelling-insensitive form for comparing words: no diacritics, tatweel, or punctuation;
// one letter for أ/إ/آ/ا, ة/ه, ى/ي; standalone "و" joined to the Arabic word after it.
function normalize(text) {
  return String(text || '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/([؀-ۿ])([a-z0-9])/g, '$1 $2') // "الfeature" → "ال feature"
    .replace(/([a-z0-9])([؀-ۿ])/g, '$1 $2')
    .replace(/(^|\s)و\s+(?=[؀-ۿ])/g, '$1و')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (text) => normalize(text).split(' ').filter(Boolean);

// Word error rate on normalized tokens (Levenshtein over words)
function wordErrorRate(reference, hypothesis) {
  const r = tokens(reference);
  const h = tokens(hypothesis);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return r.length ? prev[h.length] / r.length : 0;
}

module.exports = { normalize, wordErrorRate };
