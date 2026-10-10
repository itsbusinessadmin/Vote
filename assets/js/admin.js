import {
  sb, configured, $, h, fill, icon, fieldError, toast, modal, confirmBox, money, setTheme, notConfigured,
  uploadImage, pickFile, downloadText, slugify, voteUrl,
} from './lib.js';
import * as config from './config.js';
import { getDevice } from './device.js';
import { standingsList, rankResults, displayName, initials, valueLabel } from './standings.js';

const app = $('#app');
// Older config.js files have no ADMIN_EMAIL; fall back to the default.
const ADMIN_EMAIL = config.ADMIN_EMAIL || 'admin@vote-admin.app';
const TABS = [
  ['event', 'Event & branding', 'palette'],
  ['contestants', 'Contestants', 'mic'],
  ['criteria', 'Criteria', 'list-checks'],
  ['rules', 'Voting rules', 'shield-check'],
  ['payments', 'Payments', 'credit-card'],
  ['votes', 'Votes & voters', 'vote'],
  ['screenshot', 'Screenshot', 'camera'],
];

let events = [];
let ev = null;          // current event
let tab = localStorage.getItem('admin_tab') || 'event';
let pendingCount = 0;
let refreshTimer = null;

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
async function main() {
  if (!configured) return notConfigured(app);
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  const { data: ok, error } = await sb.rpc('claim_admin');
  if (error || !ok) {
    fill(app, h('div.center-card',
      h('h2', 'Not authorized'),
      h('p.muted', `${session.user.email} is not an admin of this app.`),
      h('button.btn', { onclick: async () => { await sb.auth.signOut(); location.reload(); } }, 'Sign out')));
    return;
  }
  getDevice().then((d) => sb.rpc('touch_admin_device', { p_device: d }));
  await loadEvents();
  renderShell();
}

async function renderLogin() {
  const { data: hasAdmin } = await sb.rpc('admin_exists');
  const setup = !hasAdmin;
  const pass = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minLength: 6 });
  const confirm = setup ? h('input', { type: 'password', autocomplete: 'new-password', required: true }) : null;
  const submit = h('button.btn.primary.block', { type: 'submit' }, setup ? 'Set password & sign in' : 'Sign in');

  const go = async () => {
    const pw = pass.value;
    fieldError(pass, ''); if (confirm) fieldError(confirm, '');
    if (pw.length < 6) return fieldError(pass, 'The password must be at least 6 characters.');
    if (setup && pw !== confirm.value) return fieldError(confirm, 'The passwords do not match.');
    submit.disabled = true;
    try {
      let { data, error } = await sb.auth.signInWithPassword({ email: ADMIN_EMAIL, password: pw });
      if (error && setup) ({ data, error } = await sb.auth.signUp({ email: ADMIN_EMAIL, password: pw }));
      if (error) return /invalid/i.test(error.message) ? fieldError(pass, 'Wrong password. Try again.') : toast(error.message, 'error');
      if (!data.session) return toast('Turn off "Confirm email" in Supabase → Authentication, then try again.', 'error');
      location.reload();
    } finally { submit.disabled = false; }
  };

  fill(app, h('main.center-card', { style: { textAlign: 'left', maxWidth: '400px' } },
    h('div.login-icon', icon('lock', 28)),
    h('h1.page-title', setup ? 'Set up admin' : 'Admin sign in'),
    h('p.muted.small', setup
      ? 'Choose the admin password. You will only need to type it once per device.'
      : 'Enter the admin password. This device will stay signed in.'),
    h('form.stack', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('label.field', h('span', setup ? 'Choose an admin password' : 'Admin password'), pass),
      setup ? h('label.field', h('span', 'Type it again'), confirm) : null,
      submit)));
  pass.focus();
}

// Devices that are signed in as admin, plus password change.
async function showDevices() {
  const me = (await getDevice()).device_token;
  const { data: list } = await sb.from('admin_devices').select('*').order('last_seen', { ascending: false });
  const pw = h('input', { type: 'password', placeholder: 'New password', 'aria-label': 'New password', autocomplete: 'new-password' });
  modal('Admin devices', h('div.stack',
    h('p.small.muted', 'Devices below stay signed in automatically. Signing out other devices makes them ask for the password again.'),
    h('div.table-wrap', h('table',
      h('thead', h('tr', ['Device', 'IP', 'Last used'].map((t) => h('th', t)))),
      h('tbody', (list || []).map((d) => h('tr',
        h('td.small', h('b', `${d.device_info?.type || 'Device'} · ${d.device_info?.os || ''}`),
          d.device_token === me ? h('span.badge.open', { style: { marginLeft: '.4rem' } }, 'this device') : null,
          h('div.muted', d.device_info?.model || d.device_info?.browser || '')),
        h('td.small.mono', d.ip || '—'),
        h('td.small', new Date(d.last_seen).toLocaleString())))))),
    h('button.btn.sm', { onclick: async () => {
      if (!(await confirmBox('Sign out other devices?', 'Every other phone or PC will need the password again.', 'Sign out others', true))) return;
      const { error } = await sb.auth.signOut({ scope: 'others' });
      if (error) return toast(error.message, 'error');
      await sb.from('admin_devices').delete().neq('device_token', me);
      toast('Other devices signed out', 'success');
    } }, 'Sign out all other devices'),
    h('h3.card-title', { style: { marginTop: '1rem' } }, 'Change password'),
    h('div.row', h('div.grow', pw), h('button.btn.sm.primary', { onclick: async () => {
      if (pw.value.length < 6) return toast('At least 6 characters.', 'error');
      const { error } = await sb.auth.updateUser({ password: pw.value });
      if (error) return toast(error.message, 'error');
      pw.value = '';
      toast('Password changed', 'success');
    } }, 'Save'))));
}

// ---------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------
async function loadEvents() {
  const { data, error } = await sb.from('events').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  events = data;
  const saved = localStorage.getItem('admin_event');
  ev = events.find((e) => e.id === saved) || events[0] || null;
  setTheme(ev?.theme_color);
}

async function saveEvent(patch, quiet = false) {
  const { data, error } = await sb.from('events').update(patch).eq('id', ev.id).select().single();
  if (error) { toast(error.message, 'error'); return false; }
  Object.assign(ev, data);
  setTheme(ev.theme_color);
  if (!quiet) toast('Saved', 'success');
  renderSide();
  return true;
}

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function countPending() {
  if (!ev) return 0;
  const { count } = await sb.from('votes').select('id', { count: 'exact', head: true }).eq('event_id', ev.id).eq('status', 'pending');
  pendingCount = count || 0;
  renderSide();
}

async function createEvent() {
  const title = h('input', { type: 'text', placeholder: 'e.g. Grand Singing Showdown 2026' });
  const res = await modal('New event', h('label.field', h('span', 'Event name'), title), [
    { label: 'Cancel', value: null },
    { label: 'Create', class: 'primary', onClick: async () => {
      const t = title.value.trim() || 'New Event';
      const slug = `${slugify(t)}-${Math.random().toString(36).slice(2, 6)}`;
      const { data, error } = await sb.from('events').insert({ title: t, slug }).select().single();
      if (error) throw error;
      return data;
    } },
  ]);
  if (!res) return;
  events.unshift(res);
  selectEvent(res.id);
}

function selectEvent(id) {
  ev = events.find((e) => e.id === id) || null;
  localStorage.setItem('admin_event', id);
  setTheme(ev?.theme_color);
  renderShell();
}

// ---------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------
function renderShell() {
  fill(app, h('div.admin', h('aside.side#side'), h('main.main#main')));
  renderSide();
  renderTab();
  countPending();
}

function renderSide() {
  const side = $('#side');
  if (!side) return;
  fill(side,
    h('div.brand', ev?.logo_url ? h('img', { src: ev.logo_url, alt: '' }) : h('span.brand-icon', icon('vote', 22)), h('span', 'Vote Admin')),
    h('label.field', h('span', 'Event'),
      h('select', { onchange: (e) => e.target.value === '__new' ? createEvent() : selectEvent(e.target.value) },
        events.map((e) => h('option', { value: e.id, selected: e.id === ev?.id }, e.title)),
        h('option', { value: '__new' }, '+ New event…'))),
    ev ? h('nav.nav', { 'aria-label': 'Admin sections' }, TABS.map(([id, label, ic]) => h('button', {
      type: 'button',
      class: id === tab ? 'active' : '',
      'aria-current': id === tab ? 'page' : null,
      onclick: () => { tab = id; localStorage.setItem('admin_tab', id); side.classList.remove('open'); renderSide(); renderTab(); },
    }, h('span.nav-label', icon(ic), label),
      id === 'payments' && pendingCount ? h('span.count', { 'aria-label': `${pendingCount} pending` }, pendingCount) : null))) : null,
    h('div.grow'),
    ev ? h('a.btn.sm', { href: voteUrl(ev.slug), target: '_blank', rel: 'noopener' }, 'Open voting page', icon('external-link', 16), h('span.sr-only', '(opens in a new tab)')) : null,
    h('button.btn.sm.ghost', { type: 'button', onclick: showDevices }, icon('lock', 16), 'Devices & password'),
    h('button.btn.sm.ghost', { type: 'button', onclick: async () => {
      await sb.auth.signOut({ scope: 'local' });
      location.reload();
    } }, icon('log-out', 16), 'Sign out this device'));
}

function header(title, ...right) {
  return h('header',
    h('div.row',
      h('button.btn.sm.menu-toggle', { type: 'button', 'aria-label': 'Open menu', 'aria-controls': 'side',
        onclick: (e) => e.currentTarget.setAttribute('aria-expanded', String($('#side').classList.toggle('open'))) }, icon('menu', 20)),
      h('h1.page-title', title)),
    h('div.row', right));
}

function renderTab() {
  clearInterval(refreshTimer);
  const main = $('#main');
  if (!ev) {
    fill(main, h('div.center-card',
      h('h2', 'Welcome!'), h('p.muted', 'Create your first event to get started.'),
      h('button.btn.primary', { onclick: createEvent }, icon('plus'), 'Create event')));
    return;
  }
  fill(main, h('div.spinner', { role: 'status', 'aria-label': 'Loading' }));
  ({ event: tabEvent, contestants: tabContestants, criteria: tabCriteria, rules: tabRules,
    payments: tabPayments, votes: tabVotes, screenshot: tabScreenshot }[tab] || tabEvent)(main)
    .catch((e) => { console.error(e); fill(main, h('p', { style: { color: 'var(--bad)' } }, e.message)); });
}

// ---------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------
function input(obj, key, type = 'text', attrs = {}) {
  const el = type === 'textarea' ? h('textarea', attrs) : h('input', { type, ...attrs });
  if (type === 'checkbox') el.checked = !!obj[key];
  else if (type === 'datetime-local') el.value = obj[key] ? toLocalInput(obj[key]) : '';
  else el.value = obj[key] ?? '';
  el.addEventListener(type === 'checkbox' ? 'change' : 'input', () => {
    obj[key] = type === 'checkbox' ? el.checked
      : type === 'number' ? (el.value === '' ? null : Number(el.value))
      : type === 'datetime-local' ? (el.value ? new Date(el.value).toISOString() : null)
      : el.value;
  });
  return el;
}
const toLocalInput = (iso) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const field = (label, el, hint) => h('label.field', h('span', label), el, hint ? h('small', hint) : null);
const check = (obj, key, title, hint) => h('label.check', input(obj, key, 'checkbox'), h('div', h('b', title), hint ? h('small', hint) : null));
function select(obj, key, options) {
  const el = h('select', { onchange: () => { obj[key] = el.value; } },
    options.map(([v, l]) => h('option', { value: v, selected: String(obj[key]) === String(v) }, l)));
  return el;
}

function imageUpload(label, key, { wide = false, hint, maxSide = 1200 } = {}) {
  const prev = h('div.preview', { class: wide ? 'wide' : '', style: ev[key] ? { backgroundImage: `url("${ev[key]}")` } : {} }, ev[key] ? '' : 'No image');
  return h('div.field',
    h('span', { style: { display: 'block', fontSize: '.85rem', fontWeight: 600, marginBottom: '.3rem' } }, label),
    h('div.upload', prev, h('div.stack',
      h('div.row',
        h('button.btn.sm', { onclick: async (e) => {
          const file = await pickFile();
          if (!file) return;
          e.target.disabled = true;
          try {
            const url = await uploadImage('assets', ev.id, file, maxSide);
            if (await saveEvent({ [key]: url })) {
              prev.style.backgroundImage = `url("${url}")`;
              prev.textContent = '';
            }
          } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
          e.target.disabled = false;
        } }, ev[key] ? 'Change' : 'Upload'),
        ev[key] ? h('button.btn.sm.ghost', { onclick: async () => {
          if (await saveEvent({ [key]: null })) renderTab();
        } }, 'Remove') : null),
      hint ? h('small.muted', hint) : null)));
}

// ---------------------------------------------------------------------
// Tab: Event & branding
// ---------------------------------------------------------------------
async function tabEvent(main) {
  const d = { ...ev };
  const url = voteUrl(ev.slug);
  const qrBox = h('div.qr');
  import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm').then(async (m) => {
    const QR = m.default || m;
    const src = await QR.toDataURL(url, { width: 360, margin: 1 });
    qrBox.append(h('img', { src, alt: 'QR code', style: { width: '140px' } }),
      h('a.btn.sm.block', { href: src, download: `${ev.slug}-qr.png`, style: { marginTop: '6px' } }, 'Download QR'));
  }).catch(() => qrBox.remove());

  fill(main,
    header('Event & branding',
      h('span.badge', { class: ev.status }, ev.status),
      h('button.btn.danger.sm', { onclick: deleteEvent }, 'Delete event')),
    h('div.card.section',
      h('h2.card-title', 'Share with your audience'),
      h('div.share', qrBox, h('div.stack.grow',
        h('code', { style: { wordBreak: 'break-all' } }, url),
        h('div.row',
          h('button.btn.sm.primary', { onclick: () => navigator.clipboard.writeText(url).then(() => toast('Link copied', 'success')) }, 'Copy link'),
          h('a.btn.sm', { href: url, target: '_blank', rel: 'noopener' }, 'Open', icon('external-link', 16), h('span.sr-only', '(opens in a new tab)'))),
        h('small.muted', ev.status === 'draft' ? 'The event is a draft. Set the status to Open so the audience can see it.' : '')))),
    h('div.card.section.stack',
      h('h2.card-title', 'Status'),
      h('div.grid-2',
        field('Voting status', select(d, 'status', [['draft', 'Draft (hidden)'], ['open', 'Open (accepting votes)'], ['closed', 'Closed (view only)']])),
        field('Opens at (optional)', input(d, 'starts_at', 'datetime-local')),
        field('Closes at (optional)', input(d, 'ends_at', 'datetime-local'), 'Voting stops automatically at this time.'))),
    h('div.card.section.stack',
      h('h2.card-title', 'Details'),
      field('Title', input(d, 'title')),
      field('Subtitle', input(d, 'subtitle', 'text', { placeholder: 'e.g. Grand Finals · Oct 20, 2026' })),
      field('Description / instructions', input(d, 'description', 'textarea', { placeholder: 'Shown to voters above the contestants.' })),
      h('div.grid-2',
        field('Link name (URL slug)', input(d, 'slug'), 'Used in the voting link. Letters, numbers and dashes.'),
        field('Theme color', input(d, 'theme_color', 'color')))),
    h('div.card.section.stack',
      h('h2.card-title', 'Images'),
      h('div.grid-2',
        imageUpload('Logo', 'logo_url', { hint: 'Square PNG works best. It also appears in screenshots.', maxSide: 600 }),
        imageUpload('Banner / background', 'banner_url', { wide: true, hint: 'Wide image for the top of the voting page.', maxSide: 1920 }))),
    h('div.row', { style: { marginTop: '1rem' } },
      h('button.btn.primary', { onclick: async () => {
        d.slug = slugify(d.slug || d.title);
        const { title, subtitle, description, slug, theme_color, status, starts_at, ends_at } = d;
        if (await saveEvent({ title, subtitle, description, slug, theme_color, status, starts_at, ends_at })) {
          events = events.map((e) => (e.id === ev.id ? ev : e));
          renderSide(); renderTab();
        }
      } }, 'Save changes')));
}

async function deleteEvent() {
  if (!(await confirmBox('Delete event?', `This permanently deletes "${ev.title}" and ALL of its contestants, criteria and votes.`, 'Delete', true))) return;
  const { error } = await sb.from('events').delete().eq('id', ev.id);
  if (error) return toast(error.message, 'error');
  events = events.filter((e) => e.id !== ev.id);
  ev = events[0] || null;
  if (ev) localStorage.setItem('admin_event', ev.id);
  renderShell();
}

// ---------------------------------------------------------------------
// Tab: Contestants
// ---------------------------------------------------------------------
async function tabContestants(main) {
  const { data: list, error } = await sb.from('contestants').select('*').eq('event_id', ev.id).order('sort_order').order('created_at');
  if (error) throw error;

  const move = async (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await Promise.all(list.map((c, k) => sb.from('contestants').update({ sort_order: k }).eq('id', c.id)));
    renderTab();
  };

  fill(main,
    header('Contestants', h('button.btn.primary', { onclick: () => editContestant(null, list.length) }, icon('plus'), 'Add contestant')),
    list.length ? h('div', list.map((c, i) => h('div.list-item',
      h('div.thumb', { style: c.photo_url ? { backgroundImage: `url("${c.photo_url}")` } : {} }, c.photo_url ? '' : initials(c.name)),
      h('div',
        h('b', c.name), c.number ? h('span.muted', `  #${c.number}`) : null,
        !c.active ? h('span.badge', { style: { marginLeft: '.5rem' } }, 'hidden') : null,
        c.description ? h('div.muted.small', c.description) : null),
      h('div.actions',
        h('button.btn.sm.icon-only', { type: 'button', onclick: () => move(i, -1), disabled: i === 0, 'aria-label': `Move ${c.name} up` }, icon('arrow-up', 16)),
        h('button.btn.sm.icon-only', { type: 'button', onclick: () => move(i, 1), disabled: i === list.length - 1, 'aria-label': `Move ${c.name} down` }, icon('arrow-down', 16)),
        h('button.btn.sm', { onclick: () => editContestant(c) }, 'Edit'),
        h('button.btn.sm.ghost.icon-only', { type: 'button', onclick: async () => {
          if (!(await confirmBox('Delete contestant?', `Delete ${c.name} and all of their votes?`, 'Delete', true))) return;
          const { error: err } = await sb.from('contestants').delete().eq('id', c.id);
          if (err) toast(err.message, 'error'); else renderTab();
        }, 'aria-label': `Delete ${c.name}` }, icon('trash-2', 16)))))) : h('div.card', h('p.muted', 'No contestants yet. Add your first one.')));
}

async function editContestant(c, order = 0) {
  const d = c ? { ...c } : { name: '', number: '', description: '', photo_url: null, active: true };
  const prev = h('div.preview', { style: d.photo_url ? { backgroundImage: `url("${d.photo_url}")`, backgroundSize: 'cover' } : {} }, d.photo_url ? '' : 'No photo');
  const body = h('div.stack',
    h('div.upload', prev, h('div.row',
      h('button.btn.sm', { onclick: async (e) => {
        const f = await pickFile();
        if (!f) return;
        e.target.disabled = true;
        try {
          d.photo_url = await uploadImage('assets', `${ev.id}/contestants`, f, 900);
          Object.assign(prev.style, { backgroundImage: `url("${d.photo_url}")`, backgroundSize: 'cover' });
          prev.textContent = '';
        } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
        e.target.disabled = false;
      } }, 'Upload photo'),
      h('button.btn.sm.ghost', { onclick: () => { d.photo_url = null; prev.style.backgroundImage = ''; prev.textContent = 'No photo'; } }, 'Remove'))),
    h('div.grid-2',
      field('Name', input(d, 'name', 'text', { placeholder: 'Contestant name' })),
      field('Number / code', input(d, 'number', 'text', { placeholder: 'e.g. 7' }))),
    field('Description', input(d, 'description', 'textarea', { placeholder: 'Song title, school, short bio…' })),
    check(d, 'active', 'Visible to voters', 'Untick to hide this contestant without deleting their votes.'));

  await modal(c ? 'Edit contestant' : 'Add contestant', body, [
    { label: 'Cancel', value: null },
    { label: 'Save', class: 'primary', onClick: async () => {
      if (!d.name.trim()) { toast('Name is required', 'error'); return false; }
      const row = { name: d.name.trim(), number: d.number || null, description: d.description || null, photo_url: d.photo_url, active: d.active };
      const { error } = c
        ? await sb.from('contestants').update(row).eq('id', c.id)
        : await sb.from('contestants').insert({ ...row, event_id: ev.id, sort_order: order });
      if (error) throw error;
      toast('Saved', 'success');
      renderTab();
    } },
  ]);
}

// ---------------------------------------------------------------------
// Tab: Criteria
// ---------------------------------------------------------------------
async function tabCriteria(main) {
  const { data: list, error } = await sb.from('criteria').select('*').eq('event_id', ev.id).order('sort_order').order('created_at');
  if (error) throw error;
  const total = list.reduce((s, c) => s + Number(c.weight), 0);

  fill(main,
    header('Criteria', h('button.btn.primary', { onclick: () => editCriterion(null, list.length) }, icon('plus'), 'Add criterion')),
    h('div.card.section',
      h('div.row.between',
        h('div', h('b', 'Total weight: '), h('span.weight-total', { class: Math.abs(total - 100) < 0.01 ? 'good' : 'bad' }, `${total}%`)),
        h('small.muted', ev.voting_mode === 'criteria'
          ? 'Voters rate every criterion, and the weights decide the final score.'
          : 'Voters see these criteria as a guide. Switch to "Rate each criterion" in Voting rules to use the weights in scoring.')),
      Math.abs(total - 100) >= 0.01 && list.length ? h('p.small', { style: { color: 'var(--warn)', marginTop: '.5rem' } },
        'Tip: the weights should add up to 100%. Scores are normalised either way.') : null),
    list.length ? h('div.section', list.map((c, i) => h('div.list-item',
      h('div.thumb', { style: { fontSize: '1rem', color: 'var(--brand)' } }, `${Number(c.weight)}%`),
      h('div', h('b', c.name), c.description ? h('div.muted.small', c.description) : null),
      h('div.actions',
        h('button.btn.sm.icon-only', { type: 'button', disabled: i === 0, onclick: async () => {
          [list[i - 1], list[i]] = [list[i], list[i - 1]];
          await Promise.all(list.map((x, k) => sb.from('criteria').update({ sort_order: k }).eq('id', x.id)));
          renderTab();
        }, 'aria-label': `Move ${c.name} up` }, icon('arrow-up', 16)),
        h('button.btn.sm', { onclick: () => editCriterion(c) }, 'Edit'),
        h('button.btn.sm.ghost.icon-only', { type: 'button', onclick: async () => {
          if (!(await confirmBox('Delete criterion?', `Delete "${c.name}"? Ratings already given for it will no longer count.`, 'Delete', true))) return;
          const { error: err } = await sb.from('criteria').delete().eq('id', c.id);
          if (err) toast(err.message, 'error'); else renderTab();
        }, 'aria-label': `Delete ${c.name}` }, icon('trash-2', 16)))))) : h('div.card.section', h('p.muted', 'No criteria yet. Example: Vocals 40%, Stage presence 30%, Audience impact 30%.')));
}

async function editCriterion(c, order = 0) {
  const d = c ? { ...c, weight: Number(c.weight) } : { name: '', description: '', weight: 0 };
  await modal(c ? 'Edit criterion' : 'Add criterion', h('div.stack',
    h('div.grid-2',
      field('Name', input(d, 'name', 'text', { placeholder: 'e.g. Vocal quality' })),
      field('Percentage (%)', input(d, 'weight', 'number', { min: 0, max: 100, step: 0.5 }))),
    field('Description', input(d, 'description', 'textarea', { placeholder: 'What should voters look for?' }))), [
    { label: 'Cancel', value: null },
    { label: 'Save', class: 'primary', onClick: async () => {
      if (!d.name.trim()) { toast('Name is required', 'error'); return false; }
      const row = { name: d.name.trim(), description: d.description || null, weight: Number(d.weight) || 0 };
      const { error } = c
        ? await sb.from('criteria').update(row).eq('id', c.id)
        : await sb.from('criteria').insert({ ...row, event_id: ev.id, sort_order: order });
      if (error) throw error;
      toast('Saved', 'success');
      renderTab();
    } },
  ]);
}

// ---------------------------------------------------------------------
// Tab: Voting rules
// ---------------------------------------------------------------------
async function tabRules(main, draft) {
  const d = draft || { ...ev };
  const paidBox = h('div.stack');
  const pricing = select(d, 'pricing', [['free', 'Free voting'], ['paid', 'Paid votes (with payment proof)']]);
  const showPaid = () => paidBox.classList.toggle('hidden', d.pricing !== 'paid');
  pricing.addEventListener('change', showPaid);

  paidBox.append(
    h('div.grid-2',
      field('Price per vote', input(d, 'price_per_vote', 'number', { min: 0, step: 0.01 })),
      field('Currency', input(d, 'currency', 'text', { maxLength: 3, placeholder: 'PHP' }), 'Three-letter code, e.g. PHP, USD.'),
      field('Max votes in one purchase', input(d, 'max_qty_per_vote', 'number', { min: 1 }))),
    field('Payment instructions', input(d, 'payment_instructions', 'textarea', { placeholder: 'Send payment to GCash 09xx-xxx-xxxx (Juan D.). Then enter the reference number below.' })),
    imageUpload('Payment QR code (optional)', 'payment_qr_url', { hint: 'For example, your GCash / Maya / bank QR.', maxSide: 900 }),
    check(d, 'require_payment_proof', 'Require a reference number or receipt', 'Voters must enter a reference no. or upload a screenshot.'),
    h('p.small.muted', 'Paid votes stay "pending" until you approve them in the Payments tab. Only approved votes count.'));

  fill(main,
    header('Voting rules'),
    h('div.card.section.stack',
      h('h2.card-title', 'How people vote'),
      h('div.grid-2',
        field('Voting style', select(d, 'voting_mode', [
          ['simple', 'Pick a contestant (criteria shown as a guide)'],
          ['criteria', 'Rate each criterion (weighted score)'],
        ])),
        field('Highest rating (criteria style)', input(d, 'score_max', 'number', { min: 2, max: 100 }), 'Voters rate from 1 up to this number.')),
      field('Pricing', pricing),
      paidBox),
    h('div.card.section.stack',
      h('h2.card-title', 'Vote limits per person'),
      h('div.grid-2',
        field('Total votes per person', input(d, 'max_votes_per_voter', 'number', { min: 0 }), '0 = unlimited. For paid events, this counts the number of votes bought.'),
        field('Different contestants per person', input(d, 'max_contestants_per_voter', 'number', { min: 0 }), '1 = may vote for only one contestant. 0 = unlimited.')),
      check(d, 'allow_repeat_contestant', 'Allow voting for the same contestant more than once',
        'Turn this on for "unlimited / paid" style voting. When it is off, each person votes for a contestant only once.'),
      h('div.small.muted', h('b', 'Presets: '),
        presetBtn('One vote only', { max_votes_per_voter: 1, max_contestants_per_voter: 1, allow_repeat_contestant: false }),
        presetBtn('Vote for up to 3 (once each)', { max_votes_per_voter: 3, max_contestants_per_voter: 3, allow_repeat_contestant: false }),
        presetBtn('10 votes, spread freely', { max_votes_per_voter: 10, max_contestants_per_voter: 0, allow_repeat_contestant: true }),
        presetBtn('Unlimited paid votes', { pricing: 'paid', max_votes_per_voter: 0, max_contestants_per_voter: 0, allow_repeat_contestant: true }))),
    h('div.card.section.stack',
      h('h2.card-title', 'Voter details to ask for'),
      check(d, 'require_name', 'Name / nickname (required)'),
      check(d, 'ask_email', 'Email address (required)'),
      check(d, 'ask_phone', 'Mobile number (required)'),
      field('Custom field (optional)', input(d, 'extra_field_label', 'text', { placeholder: 'e.g. Student ID, Section, Table no.' }), 'Leave this blank to not ask.')),
    h('div.card.section.stack',
      h('h2.card-title', 'Anti-cheat'),
      h('p.small.muted', 'The same browser is always treated as the same voter. Turn on more checks below to treat other matches as the same person too.'),
      check(d, 'limit_by_fingerprint', 'Device fingerprint (recommended)',
        'Recognises the same phone or PC even in incognito mode or after clearing data, using screen, GPU, fonts, canvas and audio signatures. Identical phone models (for example the same iPhone) can sometimes look alike.'),
      check(d, 'limit_by_contact', 'Same email or mobile number', 'One person = one email / number.'),
      check(d, 'limit_by_name', 'Same name', 'Normalised: "Juan Dela Cruz" = "juan delacruz". Strict; two people can share a name.'),
      check(d, 'limit_by_ip', 'Same network (IP address)',
        '⚠️ Everyone on the same Wi-Fi or mobile carrier may share an IP. Only use this for online-only voting, not at a live venue.'),
      check(d, 'block_bots', 'Block automated / headless browsers'),
      field('Cooldown between votes (seconds)', input(d, 'cooldown_seconds', 'number', { min: 0 }), 'Slows down spam clicking.')),
    h('div.card.section.stack',
      h('h2.card-title', 'Public display'),
      check(d, 'show_live_results', 'Show live standings on the voting page'),
      check(d, 'show_vote_counts', 'Show vote counts publicly', 'When this is off, only the ranking bars are shown.')),
    h('div.row', { style: { marginTop: '1rem' } },
      h('button.btn.primary', { onclick: async () => {
        const keys = ['voting_mode', 'score_max', 'pricing', 'price_per_vote', 'currency', 'payment_instructions',
          'require_payment_proof', 'max_qty_per_vote', 'max_votes_per_voter', 'max_contestants_per_voter',
          'allow_repeat_contestant', 'require_name', 'ask_email', 'ask_phone', 'extra_field_label', 'limit_by_fingerprint',
          'limit_by_contact', 'limit_by_name', 'limit_by_ip', 'block_bots', 'cooldown_seconds', 'show_live_results', 'show_vote_counts'];
        const patch = Object.fromEntries(keys.map((k) => [k, d[k]]));
        for (const k of ['score_max', 'price_per_vote', 'max_qty_per_vote', 'max_votes_per_voter', 'max_contestants_per_voter', 'cooldown_seconds']) {
          patch[k] = Math.max(0, Number(patch[k]) || 0);
        }
        patch.score_max = Math.min(100, Math.max(2, patch.score_max));
        patch.max_qty_per_vote = Math.max(1, patch.max_qty_per_vote);
        patch.currency = (patch.currency || 'PHP').toUpperCase().slice(0, 3);
        patch.extra_field_label = (patch.extra_field_label || '').trim() || null;
        // keep the QR uploaded from this tab
        patch.payment_qr_url = ev.payment_qr_url;
        if (await saveEvent(patch)) renderTab();
      } }, 'Save rules')));
  showPaid();

  function presetBtn(label, p) {
    return h('button.btn.sm.ghost', { style: { margin: '.2rem' }, onclick: () => { tabRules(main, { ...d, ...p }); toast(`Preset applied: ${label}. Click Save to keep it.`); } }, label);
  }
}

// ---------------------------------------------------------------------
// Tab: Payments
// ---------------------------------------------------------------------
async function tabPayments(main) {
  const filter = localStorage.getItem('pay_filter') || 'pending';
  const rows = await fetchAll(() => {
    let q = sb.from('votes').select('*, voters(name,email,phone,extra), contestants(name,number)')
      .eq('event_id', ev.id).not('amount', 'is', null).order('created_at', { ascending: false });
    if (filter !== 'all') q = q.eq('status', filter);
    return q;
  });
  const { data: allPaid } = await sb.from('votes').select('amount,status,quantity').eq('event_id', ev.id).not('amount', 'is', null);
  const sum = (s) => (allPaid || []).filter((v) => v.status === s).reduce((a, v) => a + Number(v.amount), 0);

  const paths = rows.filter((r) => r.proof_path).map((r) => r.proof_path);
  const signed = {};
  if (paths.length) {
    const { data } = await sb.storage.from('proofs').createSignedUrls(paths, 3600);
    (data || []).forEach((s) => { if (s.signedUrl) signed[s.path] = s.signedUrl; });
  }

  const review = async (ids, status) => {
    const { error } = await sb.from('votes').update({ status, reviewed_at: new Date().toISOString() }).in('id', ids);
    if (error) return toast(error.message, 'error');
    toast(status === 'approved' ? 'Approved' : 'Rejected', status === 'approved' ? 'success' : 'info');
    countPending();
    renderTab();
  };

  fill(main,
    header('Payments',
      (() => { const sel = select({ f: filter }, 'f', [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']]); sel.setAttribute('aria-label', 'Show payments'); return sel; })(),
      filter === 'pending' && rows.length ? h('button.btn.ok.sm', { onclick: async () => {
        if (await confirmBox('Approve all?', `Approve all ${rows.length} pending payments?`, 'Approve all')) review(rows.map((r) => r.id), 'approved');
      } }, 'Approve all') : null),
    ev.pricing !== 'paid' ? h('div.card.section', h('p.muted', 'This event uses free voting. Switch Pricing to "Paid" in Voting rules to accept paid votes.')) : null,
    h('div.stats',
      stat(money(sum('approved'), ev.currency), 'Approved total'),
      stat(money(sum('pending'), ev.currency), 'Awaiting review'),
      stat(String((allPaid || []).filter((v) => v.status === 'pending').length), 'Pending payments')),
    rows.length ? h('div.table-wrap', h('table',
      h('thead', h('tr', ['Receipt', 'Voter', 'Contestant', 'Votes', 'Amount', 'Reference', 'Time', 'Status', ''].map((t) => h('th', t)))),
      h('tbody', rows.map((r) => h('tr',
        h('td', r.proof_path && signed[r.proof_path]
          ? h('img.proof-thumb', { src: signed[r.proof_path], alt: 'receipt', onclick: () => modal('Receipt', h('img', { src: signed[r.proof_path], alt: 'receipt', style: { width: '100%' } })) })
          : h('span.muted', '—')),
        h('td', h('b', r.voters?.name || '—'), h('div.muted.small', [r.voters?.email, r.voters?.phone, r.voters?.extra].filter(Boolean).join(' · '))),
        h('td', r.contestants?.name || '—'),
        h('td', r.quantity),
        h('td', money(r.amount, ev.currency)),
        h('td', h('span.mono', r.payment_ref || '—')),
        h('td.small', new Date(r.created_at).toLocaleString()),
        h('td', h('span.badge', { class: r.status }, r.status)),
        h('td', h('div.row', { style: { flexWrap: 'nowrap' } },
          r.status !== 'approved' ? h('button.btn.ok.sm', { onclick: () => review([r.id], 'approved') }, 'Approve') : null,
          r.status !== 'rejected' ? h('button.btn.sm', { onclick: () => review([r.id], 'rejected') }, 'Reject') : null))))))) :
      h('div.card', h('p.muted', `No ${filter === 'all' ? '' : filter + ' '}payments.`)));

  main.querySelector('header select').addEventListener('change', (e) => { localStorage.setItem('pay_filter', e.target.value); renderTab(); });
}

const stat = (value, label) => h('div.stat', h('b', value), h('span', label));

// ---------------------------------------------------------------------
// Tab: Votes & voters
// ---------------------------------------------------------------------
async function tabVotes(main) {
  const [votes, voters, attempts] = await Promise.all([
    fetchAll(() => sb.from('votes').select('*, contestants(name,number)').eq('event_id', ev.id).order('created_at', { ascending: false })),
    fetchAll(() => sb.from('voters').select('*').eq('event_id', ev.id).order('created_at', { ascending: false })),
    sb.from('vote_attempts').select('*').eq('event_id', ev.id).order('created_at', { ascending: false }).limit(300).then((r) => r.data || []),
  ]);
  const view = localStorage.getItem('votes_view') || 'voters';
  const voterById = Object.fromEntries(voters.map((v) => [v.id, v]));
  const fpCount = countBy(voters, 'fingerprint');
  const ipCount = countBy(voters, 'ip');
  const nameCount = countBy(voters, 'name_norm');

  const flags = (v) => [
    fpCount[v.fingerprint] > 1 && `${fpCount[v.fingerprint]} voters share this device fingerprint`,
    v.ip && ipCount[v.ip] > 1 && `${ipCount[v.ip]} voters share this IP`,
    v.name_norm && nameCount[v.name_norm] > 1 && `${nameCount[v.name_norm]} voters share this name`,
    v.device_info?.private_mode_guess && 'Probably a private/incognito window',
  ].filter(Boolean);

  const search = h('input', { type: 'search', placeholder: 'Search name, email, IP, contestant…', 'aria-label': 'Search voters and votes', style: { maxWidth: '320px' } });
  const tableBox = h('div');

  const voterVotes = (id) => votes.filter((x) => x.voter_id === id && x.status !== 'rejected');
  const setBlocked = async (v, blocked) => {
    const { error } = await sb.from('voters').update({ blocked }).eq('id', v.id);
    if (error) return toast(error.message, 'error');
    toast(blocked ? 'Voter blocked. They can no longer vote.' : 'Voter unblocked', 'success');
    renderTab();
  };

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const match = (...xs) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q));
    if (view === 'voters') {
      const list = voters.filter((v) => match(v.name, v.email, v.phone, v.extra, v.ip, v.device_info?.browser, v.device_info?.os, v.fingerprint));
      fill(tableBox, list.length ? h('div.table-wrap', h('table',
        h('thead', h('tr', ['Voter', 'Device', 'Network', 'Votes', 'Flags', ''].map((t) => h('th', t)))),
        h('tbody', list.map((v) => {
          const f = flags(v);
          const vv = voterVotes(v.id);
          return h('tr', { style: v.blocked ? { opacity: 0.55 } : {} },
            h('td', h('b', v.name || '(no name)'), v.blocked ? h('span.badge.closed', { style: { marginLeft: '.4rem' } }, 'blocked') : null,
              h('div.muted.small', [v.email, v.phone, v.extra].filter(Boolean).join(' · ')),
              h('div.muted.small', new Date(v.created_at).toLocaleString())),
            h('td.small', h('div', `${v.device_info?.type || ''} · ${v.device_info?.os || ''}`), h('div.muted', v.device_info?.model || v.device_info?.browser || ''),
              h('div.mono.muted', { title: v.fingerprint }, `fp ${String(v.fingerprint).slice(0, 10)}…`)),
            h('td.small.mono', v.ip || '—'),
            h('td.small', vv.map((x) => `${x.contestants?.name || '?'}${x.quantity > 1 ? ' ×' + x.quantity : ''}${x.status === 'pending' ? ' (pending)' : ''}`).join(', ') || '—'),
            h('td.small', f.length ? f.map((t) => h('div', { style: { color: 'var(--warn)' } }, '⚠ ' + t)) : h('span.muted', '—')),
            h('td', h('div.row', { style: { flexWrap: 'nowrap' } },
              h('button.btn.sm', { onclick: () => showDevice(v) }, 'Details'),
              h('button.btn.sm', { class: v.blocked ? '' : 'danger', onclick: () => setBlocked(v, !v.blocked) }, v.blocked ? 'Unblock' : 'Block'))));
        })))) : h('div.card', h('p.muted', 'No voters yet.')));
    } else if (view === 'votes') {
      const list = votes.filter((x) => { const v = voterById[x.voter_id] || {}; return match(v.name, v.email, x.ip, x.contestants?.name, x.status); });
      fill(tableBox, list.length ? h('div.table-wrap', h('table',
        h('thead', h('tr', ['Time', 'Voter', 'Contestant', 'Qty', ev.voting_mode === 'criteria' ? 'Scores' : null, 'Status', ''].filter(Boolean).map((t) => h('th', t)))),
        h('tbody', list.map((x) => h('tr',
          h('td.small', new Date(x.created_at).toLocaleString()),
          h('td', voterById[x.voter_id]?.name || '—', h('div.muted.small.mono', x.ip || '')),
          h('td', x.contestants?.name || '—'),
          h('td', x.quantity),
          ev.voting_mode === 'criteria' ? h('td.small.mono', x.scores ? Object.values(x.scores).join(' / ') : '—') : null,
          h('td', h('span.badge', { class: x.status }, x.status)),
          h('td', h('button.btn.sm.ghost.icon-only', { type: 'button', onclick: async () => {
            if (!(await confirmBox('Delete vote?', 'Remove this vote permanently?', 'Delete', true))) return;
            const { error } = await sb.from('votes').delete().eq('id', x.id);
            if (error) toast(error.message, 'error'); else renderTab();
          }, 'aria-label': 'Delete this vote' }, icon('trash-2', 16)))))))) : h('div.card', h('p.muted', 'No votes yet.')));
    } else {
      const list = attempts.filter((a) => match(a.name, a.ip, a.code));
      fill(tableBox, list.length ? h('div.table-wrap', h('table',
        h('thead', h('tr', ['Time', 'Reason', 'Name', 'IP', 'Device'].map((t) => h('th', t)))),
        h('tbody', list.map((a) => h('tr',
          h('td.small', new Date(a.created_at).toLocaleString()),
          h('td', h('span.badge.closed', a.code)),
          h('td', a.name || '—'),
          h('td.small.mono', a.ip || '—'),
          h('td.small.mono', { title: a.user_agent }, `fp ${String(a.fingerprint || '').slice(0, 10)}…`)))))) :
        h('div.card', h('p.muted', 'No blocked attempts.')));
    }
  };
  search.addEventListener('input', draw);

  const approved = votes.filter((v) => v.status === 'approved').reduce((s, v) => s + v.quantity, 0);
  fill(main,
    header('Votes & voters',
      h('button.btn.sm', { onclick: () => exportCsv(votes, voterById) }, icon('download', 16), 'Export CSV'),
      h('button.btn.sm.danger', { onclick: async () => {
        if (!(await confirmBox('Reset all votes?', `This deletes EVERY vote, voter and log for "${ev.title}". Contestants and settings are kept. This cannot be undone.`, 'Reset votes', true))) return;
        const { error } = await sb.rpc('reset_event_votes', { p_event_id: ev.id });
        if (error) toast(error.message, 'error'); else { toast('All votes cleared', 'success'); renderTab(); }
      } }, 'Reset votes')),
    h('div.stats',
      stat(String(approved), 'Counted votes'),
      stat(String(voters.length), 'Voters'),
      stat(String(new Set(voters.map((v) => v.fingerprint)).size), 'Unique devices'),
      stat(String(new Set(voters.map((v) => v.ip).filter(Boolean)).size), 'Unique IPs'),
      stat(String(attempts.length), 'Blocked attempts')),
    h('div.row.section', { style: { marginBottom: '.75rem' } },
      ['voters', 'votes', 'attempts'].map((k) => h('button.btn.sm', {
        class: view === k ? 'primary' : '',
        onclick: () => { localStorage.setItem('votes_view', k); renderTab(); },
      }, { voters: 'Voters', votes: 'All votes', attempts: 'Blocked attempts' }[k])),
      h('div.grow'), search),
    tableBox);
  draw();
}

function countBy(list, key) {
  const m = {};
  for (const x of list) if (x[key]) m[x[key]] = (m[x[key]] || 0) + 1;
  return m;
}

function showDevice(v) {
  const info = { ...v.device_info, ip: v.ip, fingerprint: v.fingerprint, device_token: v.device_token, user_agent: v.user_agent,
    first_vote: new Date(v.created_at).toLocaleString(), last_seen: new Date(v.last_seen_at).toLocaleString() };
  modal(v.name || 'Voter', h('div.table-wrap', h('table', h('tbody', Object.entries(info).map(([k, val]) =>
    h('tr', h('th', k.replace(/_/g, ' ')), h('td.small', { style: { wordBreak: 'break-all' } }, String(val ?? '—'))))))));
}

function exportCsv(votes, voterById) {
  const cols = ['time', 'contestant', 'quantity', 'status', 'amount', 'payment_ref', 'voter', 'email', 'phone', 'extra', 'ip', 'browser', 'os', 'device', 'fingerprint', 'scores'];
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = votes.map((x) => {
    const v = voterById[x.voter_id] || {};
    return [x.created_at, x.contestants?.name, x.quantity, x.status, x.amount, x.payment_ref, v.name, v.email, v.phone, v.extra,
      x.ip, v.device_info?.browser, v.device_info?.os, v.device_info?.model || v.device_info?.type, v.fingerprint,
      x.scores ? JSON.stringify(x.scores) : ''].map(q).join(',');
  });
  downloadText(`${ev.slug}-votes.csv`, [cols.join(','), ...lines].join('\n'));
}

// ---------------------------------------------------------------------
// Tab: Screenshot (standings capture)
// ---------------------------------------------------------------------
async function tabScreenshot(main) {
  const opts = Object.assign({ names: 'show', top: '0', theme: 'dark', values: true, pending: false, title: '', note: '' },
    JSON.parse(localStorage.getItem('shot_opts') || '{}'));
  const save = () => localStorage.setItem('shot_opts', JSON.stringify(opts));
  const { data: crit } = await sb.from('criteria').select('id,name,weight').eq('event_id', ev.id).order('sort_order');
  const stage = h('div.stage');
  const box = h('div.stage-scroll', { tabIndex: 0, role: 'region', 'aria-label': 'Standings preview' }, stage);
  let results = [];

  const drawStage = () => {
    const anon = opts.names !== 'show';
    let ranked = rankResults(results, ev);
    if (Number(opts.top) > 0) ranked = ranked.filter((r) => r.rank <= Number(opts.top));
    const label = (r, i) => (opts.names === 'show' ? r.name : opts.names === 'numbers' ? `Contestant ${r.number ? '#' + r.number : '#' + (i + 1)}` : displayName(r, true, i));
    const pic = (r, i) => (!anon && r.photo_url ? { style: { backgroundImage: `url("${r.photo_url}")` } } : {});
    const picText = (r, i) => (!anon && r.photo_url ? '' : anon ? (opts.names === 'numbers' && r.number ? `#${r.number}` : '?') : initials(r.name));
    const val = (r) => {
      if (!opts.values) return '';
      const v = valueLabel(r, ev, true);
      const pend = opts.pending && Number(r.pending) ? ` (+${r.pending} pending)` : '';
      return ev.voting_mode === 'criteria' ? `${v.main} · ${v.sub}` : `${v.main} ${v.sub}${pend}`;
    };

    const top3 = ranked.slice(0, 3);
    const order = [top3[1], top3[0], top3[2]];
    stage.className = 'stage' + (opts.theme === 'light' ? ' light' : '');
    fill(stage,
      h('div.stage-head',
        ev.logo_url ? h('img', { src: ev.logo_url, alt: '', crossOrigin: 'anonymous' }) : null,
        h('div', h('h1', opts.title || ev.title), h('p', ev.subtitle || 'Current standings'))),
      ranked.length >= 3 ? h('div.podium', order.map((r) => {
        const i = ranked.indexOf(r);
        return h('div.pod', { class: r.rank === 1 ? 'first' : '' },
          h('div.pp', pic(r, i), picText(r, i)),
          h('div.place', ['🥇', '🥈', '🥉'][r.rank - 1] || `#${r.rank}`),
          h('div.nm', label(r, i)),
          h('div.sc', val(r)));
      })) : null,
      h('div.rest', ranked.slice(ranked.length >= 3 ? 3 : 0).map((r) => {
        const i = ranked.indexOf(r);
        return h('div.r', h('b', `#${r.rank}`), h('div.pp', pic(r, i), picText(r, i)), h('div', label(r, i)), h('div', val(r)));
      })),
      !ranked.length ? h('p', { style: { fontSize: '22px' } }, 'No votes yet.') : null,
      h('div.stage-foot',
        h('span', opts.note || (anon ? 'Names are hidden until the final announcement' : '')),
        h('span', `As of ${new Date().toLocaleString()}`)));
  };

  const load = async () => {
    const { data, error } = await sb.rpc('get_results', { p_event_id: ev.id });
    if (error) return toast(error.message, 'error');
    results = data || [];
    drawStage();
    drawTable();
  };

  const tableBox = h('div.section');
  const drawTable = () => {
    fill(tableBox, h('h2.card-title', 'Detailed standings (admin only)'),
      results.length ? h('div.table-wrap', h('table',
        h('thead', h('tr', ['Rank', 'Contestant', 'Votes', 'Pending', 'Voters', ev.voting_mode === 'criteria' ? 'Score' : null,
          ...(ev.voting_mode === 'criteria' ? (crit || []).map((c) => `${c.name} (${Number(c.weight)}%)`) : [])].filter(Boolean).map((t) => h('th', t)))),
        h('tbody', rankResults(results, ev).map((r) => h('tr',
          h('td', h('b', `#${r.rank}`)), h('td', r.name, r.number ? h('span.muted', ` #${r.number}`) : null),
          h('td', r.votes), h('td', r.pending), h('td', r.voters),
          ev.voting_mode === 'criteria' ? h('td', h('b', r.score == null ? '—' : `${Number(r.score).toFixed(2)}%`)) : null,
          ...(ev.voting_mode === 'criteria' ? (crit || []).map((c) => h('td', r.breakdown?.[c.id] != null ? `${r.breakdown[c.id]} / ${ev.score_max}` : '—')) : []))))))
        : h('p.muted', 'No contestants yet.'));
  };

  const opt = (key, label, options) => field(label, (() => {
    const s = select(opts, key, options);
    s.addEventListener('change', () => { save(); drawStage(); });
    return s;
  })());
  const optCheck = (key, label) => {
    const el = check(opts, key, label);
    el.querySelector('input').addEventListener('change', () => { save(); drawStage(); });
    return el;
  };
  const titleIn = input(opts, 'title', 'text', { placeholder: ev.title });
  const noteIn = input(opts, 'note', 'text', { placeholder: 'e.g. Partial results as of 9:00 PM' });
  [titleIn, noteIn].forEach((el) => el.addEventListener('input', () => { save(); drawStage(); }));

  const capture = async (copy) => {
    toast('Capturing…');
    try {
      const { toPng, toBlob } = await import('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm');
      const o = { pixelRatio: 2, cacheBust: true, skipFonts: true };
      if (copy && navigator.clipboard?.write) {
        const blob = await toBlob(stage, o);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('Image copied to clipboard', 'success');
      } else {
        const url = await toPng(stage, o);
        h('a', { href: url, download: `${ev.slug}-standings-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png` }).click();
        toast('Screenshot saved', 'success');
      }
    } catch (e) {
      console.error(e);
      toast('Capture failed: ' + (e.message || e), 'error');
    }
  };

  fill(main,
    header('Screenshot standings',
      h('button.btn.sm', { onclick: load }, icon('refresh-cw', 16), 'Refresh'),
      h('button.btn.sm', { onclick: () => capture(true) }, icon('copy', 16), 'Copy image'),
      h('button.btn.primary', { onclick: () => capture(false) }, icon('camera'), 'Capture PNG')),
    h('div.card.section',
      h('div.shot-tools',
        opt('names', 'Contestant identity', [['show', 'Show names & photos'], ['numbers', 'Numbers only'], ['hidden', 'Fully anonymous (A, B, C…)']]),
        opt('top', 'Show', [['0', 'All contestants'], ['3', 'Top 3'], ['5', 'Top 5'], ['10', 'Top 10']]),
        opt('theme', 'Style', [['dark', 'Brand color (dark)'], ['light', 'Light']]),
        field('Title', titleIn),
        field('Footer note', noteIn)),
      h('div.row', optCheck('values', 'Show votes / scores'), optCheck('pending', 'Include pending paid votes in label'))),
    box,
    tableBox);

  await load();
  refreshTimer = setInterval(load, 15000);
}

main().catch((e) => {
  console.error(e);
  fill(app, h('div.center-card', h('h2', 'Something went wrong'), h('p.muted', e.message)));
});
