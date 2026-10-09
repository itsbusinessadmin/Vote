import { h } from './lib.js';

// Sort results and assign ranks (ties share a rank).
export function rankResults(results, event) {
  const byScore = event.voting_mode === 'criteria';
  const key = (r) => (byScore ? [Number(r.score ?? -1), Number(r.votes)] : [Number(r.votes), Number(r.score ?? -1)]);
  const sorted = [...results].sort((a, b) => {
    const [a1, a2] = key(a), [b1, b2] = key(b);
    return b1 - a1 || b2 - a2 || (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });
  let prev = null, rank = 0;
  sorted.forEach((r, i) => {
    const k = key(r).join('|');
    if (k !== prev) { rank = i + 1; prev = k; }
    r.rank = rank;
  });
  return sorted;
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

export function displayName(r, anonymous, i) {
  if (!anonymous) return r.name;
  return `Contestant ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`;
}

export function valueLabel(r, event, showCounts) {
  const total = Number(r.votes);
  if (event.voting_mode === 'criteria') {
    const s = r.score == null ? '—' : `${Number(r.score).toFixed(2)}%`;
    return { main: s, sub: showCounts ? `${total} vote${total === 1 ? '' : 's'}` : '' };
  }
  return { main: showCounts ? `${total}` : '', sub: showCounts ? `vote${total === 1 ? '' : 's'}` : '' };
}

// Compact list used on the public page and the admin Results tab.
export function standingsList(results, event, { showCounts = true, anonymous = false } = {}) {
  const ranked = rankResults(results, event);
  const max = Math.max(1, ...ranked.map((r) => (event.voting_mode === 'criteria' ? Number(r.score || 0) : Number(r.votes))));
  return h('div.standings', ranked.map((r, i) => {
    const v = valueLabel(r, event, showCounts);
    const val = event.voting_mode === 'criteria' ? Number(r.score || 0) : Number(r.votes);
    return h('div.standing', { class: r.rank <= 3 ? `top${r.rank}` : '' },
      h('div.rank', `#${r.rank}`),
      h('div.pic', { style: !anonymous && r.photo_url ? { backgroundImage: `url("${r.photo_url}")` } : {} },
        anonymous ? '?' : r.photo_url ? '' : initials(r.name)),
      h('div',
        h('b', displayName(r, anonymous, i)),
        !anonymous && r.number ? h('span.muted.small', `  #${r.number}`) : null,
        h('div.bar', h('i', { style: { width: `${(val / max) * 100}%` } }))),
      h('div.val', v.main, v.sub ? h('small', v.sub) : null));
  }));
}
