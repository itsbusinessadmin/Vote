import { sb, configured, $, h, fill, icon, fieldError, toast, modal, money, setTheme, notConfigured, uploadImage, cleanUrl } from './lib.js';
import { getDevice } from './device.js';
import { standingsList, initials } from './standings.js';
import { rulesList } from './rules.js';

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

function render() {
  const state = votingState();
  const remaining = myStatus?.remaining;
  const hero = h('header.hero', {
    class: event.banner_url ? 'has-banner' : '',
    style: event.banner_url ? { backgroundImage: `url("${event.banner_url}")` } : {},
  }, h('div.hero-inner',
    event.logo_url ? h('img.logo', { src: event.logo_url, alt: `${event.title} logo`, width: 96, height: 96 }) : null,
    h('div.grow',
      h('h1', event.title),
      event.subtitle ? h('p', event.subtitle) : null),
    h('span.badge.on-hero', { class: state.open ? 'open' : 'closed' },
      state.open ? 'Voting open' : state.text)));

  const info = h('div.info-bar',
    h('div.card',
      h('h2.card-title', 'How to vote'),
      event.description ? h('p.small', event.description) : null,
      h('ul.rules.small', rulesList(event).map((t) => h('li', t))),
      myStatus?.blocked ? h('p.small', { style: { color: 'var(--bad-ink)', fontWeight: 700 } }, 'This device has been blocked by the organizer.') :
      remaining != null ? h('p', h('b', `You have ${remaining} vote${remaining === 1 ? '' : 's'} left.`)) : null),
    criteria.length ? h('div.card',
      h('h2.card-title', 'Judging criteria'),
      h('div.criteria-list', criteria.map((c) => h('div.criterion',
        h('b', c.name), h('span.pct', { 'aria-label': `${Number(c.weight)} percent` }, `${Number(c.weight)}%`),
        c.description ? h('p', c.description) : null)))) : null);

  const grid = h('div.contestants', contestants.map((c, i) => {
    const v = votedInfo(c.id);
    const canVote = state.open && !myStatus?.blocked && (remaining == null || remaining > 0) &&
      (event.allow_repeat_contestant || !v);
    const link = cleanUrl(c.link_url);
    // The photo doubles as a button: play the video, or open the link in a new tab.
    const photoTag = c.video_url ? 'button.photo.media' : link ? 'a.photo.media' : 'div.photo';
    const photoAttrs = c.video_url ? { type: 'button', onclick: () => playVideo(c, link), 'aria-label': `Play ${c.name}'s video` }
      : link ? { href: link, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${c.name}'s link (opens in a new tab)` } : {};
    return h('article.contestant',
      h(photoTag, photoAttrs,
        c.photo_url
          // Lazy-load photos below the fold; the first few load right away.
          ? h('img', { src: c.photo_url, alt: photoTag === 'div.photo' ? `Photo of ${c.name}` : '', width: 400, height: 500, decoding: 'async', loading: i < 4 ? 'eager' : 'lazy' })
          : h('div.initials', { 'aria-hidden': 'true' }, initials(c.name)),
        c.video_url ? h('span.media-badge', { 'aria-hidden': 'true' }, h('span.play-circle', icon('play', 28)), h('span', 'Watch'))
          : link ? h('span.media-badge.link', { 'aria-hidden': 'true' }, icon('external-link', 16), h('span', 'Open link')) : null,
        c.number ? h('span.no', `#${c.number}`) : null,
        v ? h('span.voted', { class: v.status === 'pending' ? 'pending' : '' },
          v.status === 'pending' ? [icon('clock', 14), `${v.quantity} pending`] : [icon('check', 14), `Voted${v.quantity > 1 ? ` ×${v.quantity}` : ''}`]) : null),
      h('div.body',
        h('h3', c.name),
        c.description ? h('div.desc', c.description) : h('div.desc'),
        h('button.btn.primary.block', { type: 'button', disabled: !canVote, onclick: () => openVote(c), 'aria-label': canVote ? `Vote for ${c.name}` : null },
          !state.open ? state.button : v && !event.allow_repeat_contestant ? [icon('check'), 'Voted'] : 'Vote')));
  }));

  // iOS-style: a compact glass title bar slides in once the big header is gone.
  const topbar = h('div.topbar', { 'aria-hidden': 'true' },
    event.logo_url ? h('img', { src: event.logo_url, alt: '' }) : null,
    h('b', event.title),
    remaining != null ? h('span.pill', `${remaining} vote${remaining === 1 ? '' : 's'} left`) : null);

  fill(app, topbar, hero, h('main.wrap',
    info,
    h('h2', 'Contestants'),
    contestants.length ? grid : h('p.muted', 'Contestants will appear here soon.'),
    event.show_live_results ? h('section', { style: { marginTop: '2.5rem' } },
      h('h2', 'Live standings'), h('div#results', h('div.spinner', { role: 'status', 'aria-label': 'Loading' }))) : null),
  h('footer.footer', 'Votes are protected against duplicates and spam.'));
  // Watch the header only once it is on the page.
  heroObserver?.disconnect();
  heroObserver = new IntersectionObserver(([e]) => topbar.classList.toggle('show', !e.isIntersecting), { rootMargin: '-40px 0px 0px 0px' });
  heroObserver.observe(hero);
}

let resultsBusy = false;
async function loadResults() {
  if (!$('#results') || resultsBusy) return;
  resultsBusy = true;
  let data;
  try { ({ data } = await sb.rpc('get_results', { p_event_id: event.id })); } finally { resultsBusy = false; }
  const box = $('#results'); // re-read: the page may have re-rendered meanwhile
  if (!data || !box) return;
  fill(box, data.length ? standingsList(data, event, { showCounts: event.show_vote_counts }) : h('p.muted', 'No votes yet.'));
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
