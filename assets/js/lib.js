import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { icon } from './icons.js';

export { icon };

// supabase-js is loaded by a classic <script defer> in the page (window.supabase).
export const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');
if (configured && !window.supabase) throw new Error('Could not load the Supabase library. Check your internet connection and reload.');
export const sb = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ---------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// h('div.card#x', { onclick, class, style, ... }, ...children)
export function h(tag, attrs, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs != null && attrs !== false && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// replaceChildren() that skips null/false, like h() does.
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

// Toasts are announced to screen readers: errors assertively, the rest politely.
export function toast(msg, type = 'info') {
  let box = $('#toasts');
  if (!box) {
    document.body.append((box = h('div#toasts',
      h('div.toast-region', { role: 'status', 'aria-live': 'polite' }),
      h('div.toast-region', { role: 'alert', 'aria-live': 'assertive' }))));
  }
  const t = h('div.toast', { class: type }, msg);
  box.children[type === 'error' ? 1 : 0].append(t);
  const ms = type === 'error' ? 5200 : 3200;
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 500);
}

// Inline error under a form field, linked with aria-describedby.
// Pass an empty message to clear it.
let errSeq = 0;
export function fieldError(input, message) {
  const wrap = input?.isConnected && (input.closest('label.field, .field') || input.parentElement);
  if (!wrap) return;
  let el = wrap.querySelector(':scope > .field-error');
  if (!message) {
    el?.remove();
    input.removeAttribute('aria-invalid');
    return;
  }
  if (!el) wrap.append((el = h('small.field-error', { id: `err-${++errSeq}` })));
  el.textContent = message;
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', el.id);
  input.focus();
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Accessible dialog: named by its title, Escape closes, Tab stays inside,
// focus returns to the opener on close. With xOnly, only the × button closes
// it (no Escape, no tap outside), e.g. while someone is paying.
let dialogSeq = 0;
export function modal(title, body, actions = [], { className = '', xOnly = false } = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const titleId = `dlg-${++dialogSeq}`;
    const close = (val) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); if (!xOnly) close(null); return; }
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const dialog = h('div.modal', { class: className, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div.modal-head', h('h2', { id: titleId }, title),
        h('button.icon-btn', { type: 'button', onclick: () => close(null), 'aria-label': 'Close' }, icon('x', 20))),
      h('div.modal-body', body),
      actions.length ? h('div.modal-actions', actions.map((a) =>
        h('button.btn', { type: 'button', class: a.class || '', onclick: async (e) => {
          if (!a.onClick) return close(a.value);
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.setAttribute('aria-busy', 'true');
          try { const r = await a.onClick(); if (r !== false) close(r ?? a.value); }
          catch (err) { toast(err.message || String(err), 'error'); }
          finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
        } }, a.label))) : null);
    const wrap = h('div.modal-wrap', { onclick: (e) => !xOnly && e.target === wrap && close(null) }, dialog);
    document.body.append(wrap);
    document.addEventListener('keydown', onKey, true);
    (dialog.querySelector('.modal-body input, .modal-body textarea, .modal-body select') ||
      dialog.querySelector('.modal-actions button.primary, .modal-actions button.danger, .modal-actions button.ok') ||
      dialog.querySelector('button'))?.focus();
  });
}

export const confirmBox = (title, text, okLabel = 'Confirm', danger = false) =>
  modal(title, h('p', text), [
    { label: 'Cancel', value: false },
    { label: okLabel, value: true, class: danger ? 'danger' : 'primary' },
  ]);

export function money(n, cur = 'PHP') {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n || 0); }
  catch { return `${cur} ${Number(n || 0).toFixed(2)}`; }
}

export function setTheme(color) {
  if (color) document.documentElement.style.setProperty('--brand', color);
}

export function notConfigured(root) {
  fill(root, h('div.center-card',
    h('h2', 'Almost there!'),
    h('p', 'Connect your free Supabase project first. Open ', h('code', 'assets/js/config.js'),
      ' and paste your Project URL and anon key. The full steps are in the README.')));
}

// ---------------------------------------------------------------------
// Images: shrink before upload to save free storage and bandwidth
// ---------------------------------------------------------------------
export async function compressImage(file, maxSide = 1200, quality = 0.85) {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement('canvas'), {
    width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale),
  });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => canvas.toBlob(r, type, quality));
  return blob && blob.size < file.size ? new File([blob], file.name, { type }) : file;
}

export async function uploadImage(bucket, folder, file, maxSide) {
  const img = await compressImage(file, maxSide);
  const ext = (img.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from(bucket).upload(path, img, { contentType: img.type, upsert: false });
  if (error) throw error;
  if (bucket === 'proofs') return path;
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export const MAX_VIDEO_MB = 50;
const TARGET_VIDEO_MB = 45; // what bigger videos are compressed down to

// Re-encodes a video in the browser (WebCodecs, via mediabunny) so it fits in
// targetMB. onProgress gets a number from 0 to 1.
export async function compressVideo(file, targetMB = TARGET_VIDEO_MB, onProgress) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser cannot compress videos. Use the latest Chrome or Edge, or compress it first.');
  }
  const mb = await import('https://cdn.jsdelivr.net/npm/mediabunny@1.61.1/+esm');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const duration = await input.computeDuration();
  if (!duration) throw new Error('Could not read the video length.');
  const audioBitrate = 96_000;

  const SIDES = [1080, 720, 540, 360];
  const attempt = async (budget, minStep) => {
    // Capped at 8 Mbps: plenty for the pop-up player, and encoders overshoot less.
    const videoBitrate = Math.min(8_000_000, Math.max(200_000, Math.floor((budget * 8 * 0.95) / duration) - audioBitrate));
    // Lower bitrates look better at a smaller size; cap the short side.
    const step = Math.max(minStep, videoBitrate > 2_500_000 ? 0 : videoBitrate > 1_000_000 ? 1 : videoBitrate > 500_000 ? 2 : 3);
    const shortSide = SIDES[Math.min(step, SIDES.length - 1)];
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
    const conversion = await mb.Conversion.init({
      input, output, tracks: 'primary', showWarnings: false,
      video: async (track) => {
        const w = track.displayWidth, h = track.displayHeight;
        const scale = Math.min(1, shortSide / Math.min(w, h));
        const even = (n) => Math.max(2, Math.round(n / 2) * 2);
        const width = even(w * scale), height = even(h * scale);
        const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width, height, bitrate: videoBitrate });
        // Constant bitrate keeps the file size predictable.
        return { width, height, fit: 'fill', codec: codec || undefined, quality: new mb.Quality({ bitrate: videoBitrate, bitrateMode: 'constant' }), forceTranscode: true };
      },
      audio: async () => {
        const codec = await mb.getFirstEncodableAudioCodec(['aac', 'opus'], { bitrate: audioBitrate });
        return codec ? { codec, quality: new mb.Quality({ bitrate: audioBitrate }), forceTranscode: true } : { discard: true };
      },
    });
    if (!conversion.isValid) throw new Error('This video format cannot be compressed in the browser.');
    conversion.onProgress = (p) => onProgress?.(p);
    await conversion.execute();
    return { buf: output.target.buffer, step };
  };

  // Encoders can overshoot the bitrate, especially at high resolutions; if
  // that happens, try again smaller.
  const limit = targetMB * 1024 * 1024;
  let budget = limit, minStep = 0, buf;
  for (let i = 0; i < 3; i++) {
    let step;
    ({ buf, step } = await attempt(budget, minStep));
    if (buf.byteLength <= limit) break;
    budget *= Math.min(0.9, (limit / buf.byteLength) * 0.9);
    minStep = step + 1;
  }
  if (buf.byteLength > limit) throw new Error(`Could only compress the video to ${(buf.byteLength / 1048576).toFixed(0)} MB. Trim it and try again.`);
  return new File([buf], file.name.replace(/\.[^.]*$/, '') + '.mp4', { type: 'video/mp4' });
}

// Videos up to MAX_VIDEO_MB are uploaded as-is; bigger ones are compressed
// to TARGET_VIDEO_MB first. onStatus gets a short progress message.
export async function uploadVideo(folder, file, onStatus) {
  if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
    const from = (file.size / 1048576).toFixed(0);
    onStatus?.(`Compressing ${from} MB video…`);
    file = await compressVideo(file, TARGET_VIDEO_MB, (p) => onStatus?.(`Compressing ${from} MB video… ${Math.round(p * 100)}%`));
    onStatus?.(`Uploading compressed video (${(file.size / 1048576).toFixed(0)} MB)…`);
  }
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const type = file.type || (ext === 'mov' ? 'video/quicktime' : `video/${ext}`);
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from('videos').upload(path, file, { contentType: type, upsert: false });
  if (error) throw error;
  return sb.storage.from('videos').getPublicUrl(path).data.publicUrl;
}

// Accepts "youtube.com/..." as well as full URLs; returns null for anything
// that is not an http(s) link.
export function cleanUrl(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null;
  } catch { return null; }
}

export function pickFile(accept = 'image/*') {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, onchange: () => resolve(inp.files[0] || null) });
    inp.click();
  });
}

export function downloadText(filename, text, type = 'text/csv') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
}

export function voteUrl(slug) {
  return new URL(`index.html?e=${encodeURIComponent(slug)}`, location.href).href;
}
