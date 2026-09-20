/**
 * core/correlate.js — the join between Gong and the CX Portal.
 *
 * The two systems never agreed on a name. Gong labels a call from whatever the
 * organiser typed in the invite ("RW Supply + Design"); the tracker holds the
 * legal entity ("RW Supply and Design LLC"). Neither has the other's id, so the
 * customer name is the only join available, and matching it exactly finds
 * almost nothing — the first attempt matched 2 of 9.
 *
 * Everything here is name normalisation plus one honest admission: a match can
 * be exact, strong or weak, and the caller is told which. A weak match feeding
 * a status report silently is how a customer ends up reading another
 * customer's go-live date.
 */

/**
 * Words that carry no identity. Stripped before comparing, because one system
 * writes "Inc." and the other does not, and that difference is not a customer.
 */
const NOISE = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'group', 'holdings', 'the', 'and', 'of', 'plc', 'gmbh', 'sa', 'nv', 'bv',
  'pty', 'llp', 'lp', 'partners', 'international', 'intl',
]);

/** Lowercase, depunctuate, drop the noise words. The comparison key. */
export function normalise(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NOISE.has(w))
    .join(' ')
    .trim();
}

/** The same key with spaces removed — catches "Bluprintx" vs "Blu printx". */
const tight = (name) => normalise(name).replace(/ /g, '');

/** The longest word that is not noise: the safest thing to probe an API with. */
export function distinctiveWord(name) {
  return normalise(name).split(' ').sort((a, b) => b.length - a.length)[0] || '';
}

/**
 * How alike two names are, and how much that is worth trusting.
 *
 * `exact`  — identical once normalised. Safe to act on.
 * `strong` — one contains the other, or they share every distinctive word.
 *            Safe enough to act on, and reported so it can be checked.
 * `weak`   — they share one long word and nothing contradicts it. Surfaced for
 *            a person to confirm, never auto-applied.
 * `null`   — no relationship worth reporting.
 */
export function compare(a, b) {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return null;

  if (na === nb) return { confidence: 'exact', score: 1 };

  const ta = tight(a);
  const tb = tight(b);
  if (ta === tb) return { confidence: 'exact', score: 1 };

  // Containment, compared as whole words rather than as a substring.
  // Substring containment matched "Apple" to "Pineapple Corp", which is the
  // kind of false positive that puts one customer's go-live date in another
  // customer's report. A name contains another only when its words do.
  const contiguous = (outer, inner) => {
    if (inner.length >= outer.length) return false;
    for (let i = 0; i + inner.length <= outer.length; i += 1) {
      if (inner.every((w, j) => outer[i + j] === w)) return true;
    }
    return false;
  };

  const la = na.split(' ');
  const lb = nb.split(' ');
  const shortWords = la.length <= lb.length ? la : lb;
  const longWords = la.length <= lb.length ? lb : la;

  if (contiguous(longWords, shortWords)) {
    return { confidence: 'strong', score: shortWords.length / longWords.length };
  }

  const wa = new Set(la);
  const wb = new Set(lb);
  const shared = [...wa].filter((w) => wb.has(w));
  if (!shared.length) return null;

  const overlap = shared.length / Math.min(wa.size, wb.size);
  if (overlap === 1) return { confidence: 'strong', score: 1 };

  // One shared long word is suggestive, not conclusive.
  const longest = shared.sort((x, y) => y.length - x.length)[0];
  if (longest.length >= 5) return { confidence: 'weak', score: overlap };

  return null;
}

const RANK = { exact: 3, strong: 2, weak: 1 };

/**
 * Best CX Portal customer for one Gong customer name.
 *
 * @param name        the Gong-side name
 * @param candidates  [{ name, ...anything }] from the tracker
 */
export function bestMatch(name, candidates = []) {
  let best = null;

  for (const c of candidates) {
    const cmp = compare(name, c.name ?? c.customerName ?? c);
    if (!cmp) continue;

    const better = !best
      || RANK[cmp.confidence] > RANK[best.confidence]
      || (RANK[cmp.confidence] === RANK[best.confidence] && cmp.score > best.score);

    if (better) best = { ...cmp, candidate: c };
  }
  return best;
}

/**
 * Correlate two lists of customers.
 *
 * Returns every relationship found plus both kinds of absence, because the
 * absences are the useful part: a customer with calls and no tracker project is
 * unbilled work, and a tracker project with no calls is a delivery nobody is
 * talking to.
 *
 * @param gong   [{ name, ... }] — Warp projects, i.e. Gong-derived customers
 * @param cx     [{ name, ... }] — CX Portal tracker customers
 * @param minimum  lowest confidence to count as matched (default 'strong')
 */
export function correlate(gong = [], cx = [], { minimum = 'strong' } = {}) {
  const floor = RANK[minimum] ?? RANK.strong;

  const matched = [];
  const review = [];          // found something, below the bar
  const gongOnly = [];
  const takenCx = new Set();

  for (const g of gong) {
    const gname = g.name ?? g.customer ?? String(g);
    const hit = bestMatch(gname, cx);

    if (!hit) { gongOnly.push(g); continue; }

    const row = {
      gong: g,
      cxportal: hit.candidate,
      confidence: hit.confidence,
      score: Number(hit.score.toFixed(3)),
    };

    if (RANK[hit.confidence] >= floor) {
      matched.push(row);
      takenCx.add(hit.candidate);
    } else {
      review.push(row);
    }
  }

  const cxOnly = cx.filter((c) => !takenCx.has(c));

  return {
    matched,
    review,
    gongOnly,
    cxOnly,
    summary: {
      gong: gong.length,
      cxportal: cx.length,
      matched: matched.length,
      needsReview: review.length,
      gongOnly: gongOnly.length,
      cxOnly: cxOnly.length,
    },
  };
}
