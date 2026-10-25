import { sb, configured, $, h, fill, icon, fieldError, toast, modal, money, setTheme, notConfigured, uploadImage, cleanUrl } from './lib.js';
import { getDevice, formFactor } from './device.js';
import { standingsList, initials } from './standings.js';
import { rulesList } from './rules.js';
import { CREDITS_DEFAULTS } from './credits.js';

const app = $('#app');
const ID_KEY = 'vote_identity';

let event, contestants = [], criteria = [], myStatus = null, device;
// Start the device check right away; it runs while the event data downloads.
const devicePromise = getDevice().then((d) => (device = d));

function savedIdentity() {
  try { return JSON.parse(localStorage.getItem(ID_KEY)) || {}; } catch { return {}; }
}
function saveIdentity(id) {
  try { localStorage.setItem(ID_KEY, JSON.stringify(id)); } catch {}
}
const voterPayload = (identity = savedIdentity()) => ({ ...identity, ...device });

const bySortOrder = (a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);

async function main() {
  if (!configured) return notConfigured(app);
  const slug = new URLSearchParams(location.search).get('e');
  if (!slug) return renderEventList();

  if (!(await loadEvent(slug))) return;

  // Show the page now; this device's votes fill in a moment later.
  render();
  await devicePromise;
  await refreshStatus();
  render();
  scheduleWindowChanges();
  watchAdminChanges(slug);

  if (event.show_live_results) loadResults();
  // Poll results every 15 s (if shown), and not at all while the tab is hidden.
  setInterval(() => { if (!document.hidden && event?.show_live_results) loadResults(); }, 15000);
  // While a credit payment waits for the organizer, check every 10 s so the
  // votes appear on this device as soon as it is approved.
  setInterval(async () => {
    if (document.hidden || !myStatus?.credits_pending) return;
    const before = { credits: myStatus.credits, pending: myStatus.credits_pending };
    await refreshStatus();
    if (myStatus.credits > before.credits) {
      const added = myStatus.credits - before.credits;
      toast(`Payment confirmed! ${plural(added, 'extra vote')} added.`, 'success');
    } else if (myStatus.credits_pending < before.pending) {
      toast('A payment was not confirmed. Contact the organizer if you think this is a mistake.', 'error');
    }
    if (myStatus.credits !== before.credits || myStatus.credits_pending !== before.pending) render();
  }, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && event?.show_live_results) loadResults(); });
}

// Event, contestants and criteria in a single request. Returns false (and
// shows a message) when the event is missing or unpublished.
async function loadEvent(slug) {
  const { data, error } = await sb.from('events').select('*, contestants(*), criteria(*)').eq('slug', slug).maybeSingle();
  if (error && event) return true; // network blip on a reload: keep showing what we have
  if (error || !data) {
    fill(app, h('div.center-card', h('h2', 'Event not found'), h('p.muted', 'Check the link you were given.')));
    event = null;
    return false;
  }
  ({ contestants, criteria, ...event } = data);
  contestants = contestants.filter((c) => c.active).sort(bySortOrder);
  criteria = criteria.sort(bySortOrder);
  document.title = event.title;
  setTheme(event.theme_color);
  if (event.logo_url) {
    const fav = document.head.querySelector('link[rel=icon]') || document.head.appendChild(h('link', { rel: 'icon' }));
    fav.href = event.logo_url;
  }
  return true;
}

// Changes made in the admin page show up here without a reload: Supabase
// Realtime tells us when this event, its contestants or its criteria change.
// If Realtime is unavailable (the free plan allows 200 connections at once)
// we poll instead. The connection is closed while the tab is hidden.
function watchAdminChanges(slug) {
  let timer = null, channel = null, pollTimer = null, wasShowingResults = event.show_live_results;
  const reload = () => {
    clearTimeout(timer);
    // Debounced: one admin save can touch many rows (e.g. reordering).
    timer = setTimeout(async () => {
      const ok = await loadEvent(slug);
      if (!ok) return;
      await refreshStatus();
      render();
      scheduleWindowChanges(); // start/end times may have changed
      if (event.show_live_results && !wasShowingResults) loadResults();
      wasShowingResults = event.show_live_results;
    }, 400);
  };
  // Deletes can't be filtered by event (they only carry the row id), so
  // ignore deletes of rows that aren't on this page.
  const onChange = (p) => {
    if (p?.eventType === 'DELETE' && ![...contestants, ...criteria].some((x) => x.id === p.old?.id)) return;
    reload();
  };
  const startPolling = () => { pollTimer ||= setInterval(() => { if (!document.hidden) reload(); }, 30000); };
  const connect = () => {
    if (channel || !event) return;
    const id = event.id;
    channel = sb.channel(`event-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `id=eq.${id}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contestants', filter: `event_id=eq.${id}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'criteria', filter: `event_id=eq.${id}` }, onChange)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'contestants' }, onChange)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'criteria' }, onChange)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { clearInterval(pollTimer); pollTimer = null; }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') startPolling();
      });
  };
  const disconnect = () => { if (channel) { sb.removeChannel(channel); channel = null; } };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { disconnect(); return; }
    reload(); // catch up on anything missed while hidden
    connect();
  });
  connect();
}

// Re-render when voting opens or closes while the page is open.
function scheduleWindowChanges() {
  for (const t of [event.starts_at, event.ends_at]) {
    const ms = t ? Date.parse(t) - Date.now() : -1;
    if (ms > 0 && ms < 2 ** 31 - 1) setTimeout(render, ms + 500);
  }
}

async function renderEventList() {
  const { data } = await sb.from('events').select('slug,title,subtitle,logo_url,status,theme_color')
    .in('status', ['open', 'closed']).order('created_at', { ascending: false });
  const open = (data || []).filter((e) => e.status === 'open');
  if (open.length === 1) {
    location.replace(`?e=${encodeURIComponent(open[0].slug)}`);
    return;
  }
  fill(app, h('div.wrap', { style: { maxWidth: '640px' } },
    h('h1', { style: { marginTop: '2rem' } }, 'Events'),
    !data?.length ? h('p.muted', 'No events are open for voting right now.') : null,
    h('div.stack', (data || []).map((e) => h('a.card.row', { href: `?e=${encodeURIComponent(e.slug)}`, style: { textDecoration: 'none', color: 'inherit' } },
      e.logo_url ? h('img', { src: e.logo_url, alt: '', style: { width: '56px', height: '56px', objectFit: 'contain', borderRadius: '12px' } }) : null,
      h('div.grow', h('b', e.title), e.subtitle ? h('div.muted.small', e.subtitle) : null),
      h('span.badge', { class: e.status }, e.status === 'open' ? 'Voting open' : 'Closed'))))));
}

async function refreshStatus() {
  const { data } = await sb.rpc('my_vote_status', { p_event_id: event.id, p_voter: voterPayload() });
  if (data) myStatus = data;
}

function votingState() {
  const now = Date.now();
  if (event.status !== 'open' || (event.ends_at && now > Date.parse(event.ends_at))) return { open: false, text: 'Voting is closed', button: 'Voting closed' };
  if (event.starts_at && now < Date.parse(event.starts_at)) {
    return { open: false, text: `Voting opens ${new Date(event.starts_at).toLocaleString()}`, button: 'Not open yet' };
  }
  return { open: true };
}

function votedInfo(contestantId) {
  return myStatus?.votes?.find((v) => v.contestant_id === contestantId);
}

let heroObserver = null;
let view = 'contestants';          // or 'standings' (when live results are on)
let query = '';                    // contestant search
const openPanels = new Set();      // "How voting works" etc. stay open across re-renders
let lastResults = null;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// iOS-style disclosure row that remembers whether it is open.
function disclosure(key, title, ...body) {
  const d = h('details.disclosure', { open: openPanels.has(key) },
    h('summary', h('span', title), icon('chevron-down', 18)), h('div.disclosure-body', body));
  d.addEventListener('toggle', () => (d.open ? openPanels.add(key) : openPanels.delete(key)));
  return d;
}

// Shown instead of the voting page on phones and tablets when the event is
// set to "desktop or laptop only". Worded as the anti-cheat block it is.
function renderComputerOnly() {
  heroObserver?.disconnect();
  fill(app,
    event.banner_url ? h('header.hero.has-banner',
      h('img.banner-fill', { src: event.banner_url, alt: '', 'aria-hidden': 'true' }),
      h('img.banner-img', { src: event.banner_url, alt: '' })) : h('header.hero.plain'),
    h('main.event-head', h('div.event-card.computer-only',
      h('div.computer-icon', icon('shield-check', 30)),
      h('h1', 'Voting unavailable on this device'),
      h('p', `To keep ${event.title} fair and prevent cheating, votes can't be cast from this device.`))));
}

function render() {
  if (event.desktop_only && formFactor() !== 'desktop') return renderComputerOnly();
  const state = votingState();
  const remaining = myStatus?.remaining;
  if (!event.show_live_results) view = 'contestants';

  // The banner is shown whole, at its own shape (never cropped). When it is
  // taller than the screen allows, a blurred copy fills the sides.
  const hero = event.banner_url
    ? h('header.hero.has-banner',
      h('img.banner-fill', { src: event.banner_url, alt: '', 'aria-hidden': 'true' }),
      h('img.banner-img', { src: event.banner_url, alt: '', fetchpriority: 'high' }))
    : h('header.hero.plain');

  // Free + paid: a small Buy button sits beside "0 votes left".
  const canBuy = event.pricing === 'free_paid' && event.credits_enabled !== false && state.open && !myStatus?.blocked && remaining === 0;
  const buyPill = () => canBuy ? h('button.buy-pill', { type: 'button', onclick: openBuyCredits },
    event.credits_button || CREDITS_DEFAULTS.button) : null;

  const head = h('section.event-head',
    h('div.event-card',
      event.logo_url ? h('img.logo', { src: event.logo_url, alt: `${event.title} logo`, width: 72, height: 72 }) : null,
      h('div.event-text',
        h('h1', event.title),
        event.subtitle ? h('p.subtitle', event.subtitle) : null,
        h('div.pills',
          h('span.pill.status', { class: state.open ? 'open' : 'closed' }, h('i', { 'aria-hidden': 'true' }), state.open ? 'Voting open' : state.text),
          myStatus?.blocked ? h('span.pill.bad', 'This device is blocked')
            : remaining != null ? h('span.pill', `${plural(remaining, 'vote')} left`) : null,
          buyPill()))));

  const info = h('section.info',
    event.description ? h('p.lead', event.description) : null,
    h('div.group',
      disclosure('rules', 'How voting works', h('ul.rules', rulesList(event).map((t) => h('li', t)))),
      criteria.length ? disclosure('criteria', `Judging criteria (${criteria.length})`,
        h('div.criteria-list', criteria.map((c) => h('div.criterion',
          h('b', c.name), h('span.pct', { 'aria-label': `${Number(c.weight)} percent` }, `${Number(c.weight)}%`),
          c.description ? h('p', c.description) : null)))) : null));

  const seg = event.show_live_results ? h('div.segmented', { role: 'tablist', 'aria-label': 'Show' },
    [['contestants', 'Contestants'], ['standings', 'Standings']].map(([k, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(view === k), onclick: () => {
        if (view === k) return;
        view = k; render();
        if (k === 'standings') loadResults();
      } }, label))) : null;

  // Free + paid: once the free votes are used, bought votes can go to anyone,
  // including a contestant this voter already picked.
  const onCredit = event.pricing === 'free_paid' && event.max_votes_per_voter > 0 && (myStatus?.used ?? 0) >= event.max_votes_per_voter;
  const matches = (c) => !query || `${c.name} ${c.number || ''} ${c.description || ''}`.toLowerCase().includes(query);
  const cards = contestants.map((c, i) => {
    const v = votedInfo(c.id);
    const canVote = state.open && !myStatus?.blocked && (remaining == null || remaining > 0) &&
      (event.allow_repeat_contestant || !v || onCredit);
    const link = cleanUrl(c.link_url);
    // The photo doubles as a button: play the video, or open the link in a new tab.
    const photoTag = c.video_url ? 'button.photo.media' : link ? 'a.photo.media' : 'div.photo';
    const photoAttrs = c.video_url ? { type: 'button', onclick: () => playVideo(c, link), 'aria-label': `Play ${c.name}'s video` }
      : link ? { href: link, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${c.name}'s link (opens in a new tab)` } : {};
    const card = h('article.contestant', { class: v ? 'is-voted' : '', hidden: !matches(c) },
      h(photoTag, photoAttrs,
        c.photo_url
          // Lazy-load photos below the fold; the first few load right away.
          ? h('img', { src: c.photo_url, alt: photoTag === 'div.photo' ? `Photo of ${c.name}` : '', width: 400, height: 500, decoding: 'async', loading: i < 4 ? 'eager' : 'lazy' })
          : h('div.initials', { 'aria-hidden': 'true' }, initials(c.name)),
        c.video_url ? h('span.media-badge', { 'aria-hidden': 'true' }, h('span.play-circle', icon('play', 26)))
          : link ? h('span.media-badge.link', { 'aria-hidden': 'true' }, icon('external-link', 14), h('span', 'Link')) : null,
        c.number ? h('span.no', `#${c.number}`) : null,
        v ? h('span.voted', { class: v.status === 'pending' ? 'pending' : '' },
          v.status === 'pending' ? [icon('clock', 13), `${v.quantity} pending`] : [icon('check', 13), `Voted${v.quantity > 1 ? ` ×${v.quantity}` : ''}`]) : null),
      h('div.body',
        h('h3', c.name),
        c.description ? h('p.desc', c.description) : null,
        h('button.btn.vote', { type: 'button', class: canVote ? 'primary' : '', disabled: !canVote, onclick: () => openVote(c), 'aria-label': canVote ? `Vote for ${c.name}` : null },
          !state.open ? state.button : v && !event.allow_repeat_contestant && !(onCredit && canVote) ? [icon('check', 16), 'Voted'] : 'Vote')));
    card._match = () => matches(c);
    return card;
  });
  const empty = h('p.muted.empty', { hidden: cards.some((c) => !c.hidden) || !contestants.length }, 'No contestants match your search.');
  const search = contestants.length > 6 ? h('label.search',
    icon('search', 18),
    h('input', { type: 'search', placeholder: 'Search name or number', value: query, 'aria-label': 'Search contestants', enterKeyHint: 'search',
      oninput: (e) => {
        query = e.target.value.trim().toLowerCase();
        for (const card of cards) card.hidden = !card._match();
        empty.hidden = cards.some((c) => !c.hidden);
      } })) : null;

  // Shown above the contestants once this voter has used every vote, while a
  // credit payment is waiting, and whenever they have bought credits (so the
  // purchases button stays reachable).
  const credits = event.pricing === 'free_paid' && event.credits_enabled !== false && state.open && !myStatus?.blocked;
  const pending = Number(myStatus?.credits_pending) || 0;
  const purchases = myStatus?.purchases || [];
  const noticeText = remaining === 0
    ? [event.credits_title || CREDITS_DEFAULTS.title, event.credits_message || CREDITS_DEFAULTS.message]
    : pending ? ['Payment sent', 'Your extra votes are added here once the organizer confirms.']
    : [`You have ${plural(remaining ?? 0, 'vote')} left`, 'This includes the votes you bought.'];
  const creditsNotice = credits && (remaining === 0 || pending > 0 || purchases.length) ? h('div.credits-notice', { role: 'status' },
    h('span.credits-icon', { 'aria-hidden': 'true' }, icon('shopping-bag', 24)),
    h('div.credits-text',
      h('b', noticeText[0]),
      h('span', noticeText[1]),
      pending ? h('span.pending-chip', icon('clock', 14), `${plural(pending, 'vote')} waiting for confirmation`) : null),
    h('div.credits-actions',
      purchases.length ? h('button.notify-btn', { type: 'button', onclick: openPurchases,
        'aria-label': `My purchases${pending ? `, ${purchases.filter((p) => p.status === 'pending').length} pending` : ''}` },
        icon('bell', 20),
        pending ? h('span.notify-dot', { 'aria-hidden': 'true' }, purchases.filter((p) => p.status === 'pending').length) : null) : null,
      h('button.btn.primary.sm', { type: 'button', onclick: openBuyCredits }, icon('shopping-bag', 16), event.credits_button || CREDITS_DEFAULTS.button))) : null;

  const content = view === 'standings'
    ? h('section.standings-view', h('div#results',
      lastResults ? standingsView(lastResults) : h('div.spinner', { role: 'status', 'aria-label': 'Loading' })))
    : h('section',
      creditsNotice,
      search,
      contestants.length ? h('div.contestants', cards) : h('p.muted.empty', 'Contestants will appear here soon.'),
      empty);

  // iOS-style: a compact glass title bar slides in once the big title is gone.
  // Hidden from keyboards and screen readers until it slides in.
  const topbar = h('div.topbar', { inert: true },
    event.logo_url ? h('img', { src: event.logo_url, alt: '' }) : null,
    h('b', event.title),
    remaining != null ? h('span.pill', `${plural(remaining, 'vote')} left`) : null,
    buyPill());

  fill(app, topbar, hero, head, h('main.wrap', info, seg, content));
  // Watch the title only once it is on the page.
  heroObserver?.disconnect();
  heroObserver = new IntersectionObserver(([e]) => {
    topbar.classList.toggle('show', !e.isIntersecting);
    topbar.inert = e.isIntersecting;
  }, { rootMargin: '-40px 0px 0px 0px' });
  heroObserver.observe(head);
}

const standingsView = (data) => data.length ? standingsList(data, event, { showCounts: event.show_vote_counts }) : h('p.muted.empty', 'No votes yet.');

let resultsBusy = false;
async function loadResults() {
  if (!$('#results') || resultsBusy) return;
  resultsBusy = true;
  let data;
  try { ({ data } = await sb.rpc('get_results', { p_event_id: event.id })); } finally { resultsBusy = false; }
  const box = $('#results'); // re-read: the page may have re-rendered meanwhile
  if (!data || !box) return;
  lastResults = data;
  fill(box, standingsView(data));
}

// ---------------------------------------------------------------------
// My purchases: every credit purchase from this voter and its status
// ---------------------------------------------------------------------
const PURCHASE_STATUS = {
  pending: ['Pending', 'clock', 'Waiting for the organizer to confirm your payment.'],
  approved: ['Confirmed', 'check', 'Votes added. You can use them now.'],
  rejected: ['Refused', 'x', 'The organizer could not confirm this payment. Contact them if you think this is a mistake.'],
};

function openPurchases() {
  const list = h('div.purchase-list');
  const draw = () => {
    const items = myStatus?.purchases || [];
    fill(list, items.length ? items.map((p) => {
      const [label, ic, help] = PURCHASE_STATUS[p.status] || PURCHASE_STATUS.pending;
      return h('div.purchase', { class: p.status },
        h('span.purchase-icon', { 'aria-hidden': 'true' }, icon(ic, 18)),
        h('div.purchase-main',
          h('div.purchase-top', h('b', plural(p.quantity, 'vote')), h('span.purchase-status', label)),
          h('div.muted.small', [money(p.amount, event.currency), p.payment_ref ? `Ref ${p.payment_ref}` : null,
            new Date(p.created_at).toLocaleString()].filter(Boolean).join(' · ')),
          h('div.small.purchase-help', help)));
    }) : h('p.muted', 'No purchases yet.'));
  };
  draw();
  // Keep the list current while it is open.
  const timer = setInterval(async () => {
    if (!list.isConnected) return clearInterval(timer);
    if (document.hidden) return;
    await refreshStatus();
    draw();
  }, 10000);
  modal('My purchases', h('div.stack', h('p.small.muted', 'Votes you bought for this event on this device.'), list),
    [{ label: 'Close', value: null }]);
}

// ---------------------------------------------------------------------
// Buy credits pop-up: how to pay the organizer for more votes
// ---------------------------------------------------------------------
function openBuyCredits() {
  const price = event.credits_price != null ? Number(event.credits_price) : 1;
  const maxQty = Math.max(1, Number(event.max_qty_per_vote) || 1000);
  const box = h('div.credits');

  // Step 1: choose how many votes. The checkout button appears once a number is typed.
  const pickStep = () => {
    const qty = h('input#credits-qty', { type: 'number', min: 1, max: maxQty, step: 1, inputMode: 'numeric', placeholder: '0',
      'aria-label': 'Number of votes to buy' });
    const total = h('b.credits-total', money(0, event.currency));
    const checkout = h('button.checkout-btn', { type: 'button', hidden: true, onclick: () => payStep(count()) },
      icon('shopping-bag', 18), h('span.checkout-label'), h('span.checkout-arrow', { 'aria-hidden': 'true' }, '→'));
    const count = () => Math.min(maxQty, Math.max(0, Math.floor(Number(qty.value) || 0)));
    const update = () => {
      const n = count();
      total.textContent = money(n * price, event.currency);
      checkout.hidden = n < 1;
      checkout.querySelector('.checkout-label').textContent = `Checkout ${n} vote${n === 1 ? '' : 's'}`;
    };
    const set = (n) => { qty.value = Math.min(maxQty, Math.max(1, n)); update(); qty.focus(); };
    qty.addEventListener('input', update);
    qty.addEventListener('keydown', (e) => { if (e.key === 'Enter' && count() > 0) payStep(count()); });

    fill(box,
      h('div.credits-hero', h('span.credits-icon', { 'aria-hidden': 'true' }, icon('shopping-bag', 26)),
        h('div', h('b', 'Get more votes'), h('div.muted.small', 'Keep supporting your favorites'))),
      h('div.rate-chip', h('span', money(price, event.currency)), h('i', { 'aria-hidden': 'true' }, '='), h('span', '1 vote')),
      h('label.field', { for: 'credits-qty' }, h('span', 'How many votes would you like to buy?'),
        h('div.qty-stepper',
          h('button.step-btn', { type: 'button', 'aria-label': 'One less', onclick: () => set(count() - 1) }, '−'),
          qty,
          h('button.step-btn', { type: 'button', 'aria-label': 'One more', onclick: () => set(count() + 1) }, '+'))),
      h('div.credits-sum', h('span.muted', 'Total'), total),
      checkout);
    update();
    qty.focus();
  };

  // Step 2: pay the total by scanning the organizer's QR code, then send
  // the reference number and/or receipt so the organizer can confirm it.
  const payStep = (n) => {
    if (n < 1) return;
    let proofFile = null;
    const ref = h('input#credits-ref', { type: 'text', placeholder: 'e.g. GCash reference no.', autocomplete: 'off' });
    const proofName = h('span.muted.small#credits-proof-name', { 'aria-live': 'polite' }, 'No file chosen');
    const proofInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', tabIndex: -1, onchange: (e) => {
      proofFile = e.target.files[0] || null;
      proofName.textContent = proofFile ? proofFile.name : 'No file chosen';
    } });
    const submit = h('button.checkout-btn', { type: 'button', onclick: async () => {
      fieldError(ref, '');
      if (!ref.value.trim() && !proofFile) { fieldError(ref, 'Enter the reference number or upload your receipt.'); return; }
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      try {
        await devicePromise;
        let proofPath = null;
        if (proofFile) proofPath = await uploadImage('proofs', `${event.id}/credits`, proofFile, 1600);
        const { data, error } = await sb.rpc('buy_credits', {
          p_event_id: event.id, p_voter: voterPayload(), p_quantity: n,
          p_payment_ref: ref.value.trim() || null, p_proof_path: proofPath,
        });
        if (error) throw error;
        if (!data.ok) {
          if (data.code === 'PAYMENT_REQUIRED') fieldError(ref, data.message);
          else toast(data.message, 'error');
          return;
        }
        await refreshStatus();
        render();
        doneStep(n);
      } catch (e) {
        toast('Could not send your payment: ' + (e.message || e), 'error');
      } finally {
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
      }
    } }, icon('check', 18), h('span', 'I have paid, send for confirmation'));

    fill(box,
      h('button.btn.sm.ghost', { type: 'button', onclick: pickStep }, '← Change amount'),
      h('div.pay-summary',
        h('span.muted.small', `${n} vote${n === 1 ? '' : 's'}`),
        h('b', money(n * price, event.currency))),
      event.payment_qr_url
        ? h('div.qr-frame', h('img', { src: event.payment_qr_url, alt: 'Payment QR code' }), h('small', 'Scan with GCash, Maya or your bank app'))
        : h('p.notice', 'The organizer has not added a payment QR code yet.'),
      h('label.field', { for: 'credits-ref' }, h('span', 'Payment reference number'), ref),
      h('div.row',
        h('button.btn.sm', { type: 'button', 'aria-describedby': 'credits-proof-name', onclick: () => proofInput.click() }, icon('upload', 16), 'Upload receipt'),
        proofInput, proofName),
      h('p.confirm-note', icon('clock', 18), h('span', 'Your extra votes are added once the organizer confirms your payment.')),
      submit);
  };

  // Step 3: sent. The votes appear on this device once approved.
  const doneStep = (n) => fill(box,
    h('div.credits-done',
      h('span.done-icon', { 'aria-hidden': 'true' }, icon('check', 30)),
      h('b', 'Payment sent!'),
      h('p.muted.small', `${plural(n, 'vote')} will be added to this device as soon as the organizer confirms your payment. You can keep this page open; it updates by itself.`)));

  pickStep();
  modal('Buy vote credits', box, [], { xOnly: true });
}

// ---------------------------------------------------------------------
// Video player pop-up
// ---------------------------------------------------------------------
function playVideo(c, link) {
  const video = h('video.player', { src: c.video_url, controls: true, autoplay: true, playsInline: true, preload: 'auto',
    poster: c.photo_url || null });
  video.addEventListener('error', () => {
    video.replaceWith(h('p.player-error', 'This video could not be played on this device.'));
  }, { once: true });
  // Closing the pop-up removes the <video>, which stops playback.
  modal(c.number ? `#${c.number} · ${c.name}` : c.name, h('div.player-wrap', video,
    link ? h('a.btn.sm', { href: link, target: '_blank', rel: 'noopener noreferrer', style: { marginTop: '.75rem' } },
      'Open link', icon('external-link', 16), h('span.sr-only', '(opens in a new tab)')) : null),
  [], { className: 'video-modal' });
}

// ---------------------------------------------------------------------
// Vote dialog
// ---------------------------------------------------------------------
function openVote(c) {
  const id = savedIdentity();
  const paid = event.pricing === 'paid';
  const fields = {};
  const scores = {};
  let proofFile = null;

  const identityFields = [];
  if (event.require_name) identityFields.push(field('name', 'Your name', 'text', 'Full name or nickname', id.name));
  const domains = String(event.email_domains || '').toLowerCase().split(/[\s,;]+/).map((x) => x.replace(/^@+/, '')).filter(Boolean);
  const domainOk = (email) => !domains.length || domains.some((d) => email.endsWith('@' + d) || email.endsWith('.' + d));
  if (event.ask_email) {
    identityFields.push(field('email', 'Email', 'email', domains.length ? `you@${domains[0]}` : 'you@example.com', id.email,
      domains.length ? `Use your ${domains.map((d) => '@' + d).join(' or ')} email.` : null));
  }
  if (event.ask_phone) identityFields.push(field('phone', 'Mobile number', 'tel', '09xx xxx xxxx', id.phone));
  if (event.extra_field_label) identityFields.push(field('extra', event.extra_field_label, 'text', '', id.extra));

  function field(key, label, type, placeholder, value, hint) {
    const hintId = hint ? `hint-${key}` : null;
    fields[key] = h('input', { type, placeholder, value: value || '', 'aria-describedby': hintId,
      autocomplete: key === 'extra' ? 'off' : key === 'name' ? 'name' : key === 'phone' ? 'tel' : key });
    return h('label.field', h('span', label), fields[key], hint ? h('small', { id: hintId }, hint) : null);
  }

  const scoreRows = event.voting_mode === 'criteria' ? criteria.map((cr) => {
    const mid = Math.ceil(event.score_max / 2);
    scores[cr.id] = mid;
    const out = h('span.score-val', String(mid));
    return h('div.score-row',
      h('div.row', h('div', h('b', cr.name), h('span.muted.small', `  ${Number(cr.weight)}%`)), out),
      cr.description ? h('div.muted.small', cr.description) : null,
      h('input', { type: 'range', min: 1, max: event.score_max, step: 1, value: mid,
        'aria-label': `${cr.name} rating`, 'aria-valuetext': `${mid} out of ${event.score_max}`,
        oninput: (e) => {
          scores[cr.id] = Number(e.target.value);
          out.textContent = e.target.value;
          e.target.setAttribute('aria-valuetext', `${e.target.value} out of ${event.score_max}`);
        } }));
  }) : [];

  const remaining = myStatus?.remaining;
  const maxQty = Math.max(1, Math.min(event.max_qty_per_vote, remaining ?? Infinity));
  const qty = h('input', { type: 'number', min: 1, max: maxQty, value: 1, inputMode: 'numeric' });
  const total = h('div.total');
  const updateTotal = () => { total.textContent = `Total: ${money((Number(qty.value) || 0) * event.price_per_vote, event.currency)}`; };
  qty.addEventListener('input', updateTotal);
  updateTotal();
  const ref = h('input', { type: 'text', placeholder: 'e.g. GCash reference no.', autocomplete: 'off' });
  const proofName = h('span.muted.small#proof-name', { 'aria-live': 'polite' }, 'No file chosen');
  const proofInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', tabIndex: -1, onchange: (e) => {
    proofFile = e.target.files[0] || null;
    proofName.textContent = proofFile ? proofFile.name : 'No file chosen';
  } });

  const payment = paid ? h('div.pay-box.stack',
    h('label.field', h('span', `Number of votes (max ${maxQty})`), qty),
    total,
    event.payment_instructions ? h('p.small', { style: { whiteSpace: 'pre-line' } }, event.payment_instructions) : null,
    event.payment_qr_url ? h('img', { src: event.payment_qr_url, alt: 'Payment QR code' }) : null,
    h('label.field', h('span', 'Payment reference number'), ref),
    h('div.row',
      h('button.btn', { type: 'button', 'aria-describedby': 'proof-name', onclick: () => proofInput.click() }, icon('upload'), 'Upload receipt'),
      proofInput, proofName),
    h('small.muted', event.require_payment_proof ? 'A reference number or a receipt screenshot is required.' : 'Optional.')) : null;

  const body = h('div.stack',
    h('div.row',
      c.photo_url ? h('img', { src: c.photo_url, alt: '', style: { width: '64px', height: '64px', objectFit: 'cover', borderRadius: '12px' } }) : null,
      h('div', h('div.muted.small', c.number ? `#${c.number}` : 'Contestant'), h('h3', { style: { margin: 0 } }, c.name))),
    identityFields.length ? h('div.stack', identityFields) : null,
    scoreRows.length ? h('div', h('h3.card-title', 'Your ratings'), scoreRows) : null,
    payment);

  modal(`Vote for ${c.name}`, body, [
    { label: 'Cancel', value: null },
    { label: paid ? 'Submit vote' : 'Confirm vote', class: 'primary', onClick: async () => {
      const identity = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim()]));
      Object.values(fields).forEach((el) => fieldError(el, ''));
      if (paid) fieldError(ref, '');
      if (event.require_name && (identity.name || '').length < 2) { fieldError(fields.name, 'Please enter your name.'); return false; }
      if (event.ask_email && !domainOk((identity.email || '').toLowerCase())) {
        fieldError(fields.email, `Only ${domains.map((d) => '@' + d).join(', ')} email addresses are accepted.`);
        return false;
      }
      saveIdentity({ ...savedIdentity(), ...identity });
      await devicePromise;

      let proofPath = null;
      if (paid && proofFile) {
        try { proofPath = await uploadImage('proofs', event.id, proofFile, 1600); }
        catch (e) { toast('Receipt upload failed: ' + e.message, 'error'); return false; }
      }
      const { data, error } = await sb.rpc('cast_vote', {
        p_event_id: event.id,
        p_contestant_id: c.id,
        p_voter: voterPayload(identity),
        p_quantity: paid ? Math.max(1, Math.floor(Number(qty.value)) || 1) : 1,
        p_scores: event.voting_mode === 'criteria' ? scores : null,
        p_payment_ref: paid ? ref.value.trim() : null,
        p_proof_path: proofPath,
      });
      if (error) { toast(error.message, 'error'); return false; }
      if (!data.ok) {
        // Show field problems next to the field; everything else as a toast.
        const target = { NAME_REQUIRED: fields.name, EMAIL_REQUIRED: fields.email, EMAIL_DOMAIN: fields.email, PHONE_REQUIRED: fields.phone,
          EXTRA_REQUIRED: fields.extra, PAYMENT_REQUIRED: ref, BAD_QUANTITY: qty }[data.code];
        if (target) { fieldError(target, data.message); return false; }
        toast(data.message, 'error');
        if (['LIMIT_REACHED', 'ALREADY_VOTED', 'CONTESTANT_LIMIT', 'BLOCKED', 'VOTING_CLOSED'].includes(data.code)) {
          await refreshStatus(); render(); loadResults();
          return true;
        }
        return false;
      }
      toast(data.status === 'pending'
        ? 'Vote submitted! It will count once your payment is confirmed.'
        : 'Thank you! Your vote has been counted.', 'success');
      await refreshStatus();
      render();
      loadResults();
      return true;
    } },
  ]);
}

main().catch((e) => {
  console.error(e);
  fill(app, h('div.center-card', h('h2', 'Something went wrong'), h('p.muted', e.message)));
});
