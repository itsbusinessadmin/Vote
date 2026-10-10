import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { icon } from './icons.js';

export { icon };

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');
export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

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
// focus returns to the opener on close.
let dialogSeq = 0;
export function modal(title, body, actions = []) {
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
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const dialog = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
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
    const wrap = h('div.modal-wrap', { onclick: (e) => e.target === wrap && close(null) }, dialog);
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

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
