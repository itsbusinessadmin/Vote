import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

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

export function toast(msg, type = 'info') {
  let box = $('#toasts');
  if (!box) document.body.append((box = h('div#toasts')));
  const t = h('div.toast', { class: type }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}

export function modal(title, body, actions = []) {
  return new Promise((resolve) => {
    const close = (val) => { wrap.remove(); resolve(val); };
    const wrap = h('div.modal-wrap', { onclick: (e) => e.target === wrap && close(null) },
      h('div.modal', { role: 'dialog', 'aria-modal': 'true' },
        h('div.modal-head', h('h3', title), h('button.icon-btn', { onclick: () => close(null), 'aria-label': 'Close' }, '✕')),
        h('div.modal-body', body),
        actions.length ? h('div.modal-actions', actions.map((a) =>
          h('button.btn', { class: a.class || '', onclick: async (e) => {
            if (!a.onClick) return close(a.value);
            const btn = e.currentTarget;
            btn.disabled = true;
            try { const r = await a.onClick(); if (r !== false) close(r ?? a.value); }
            catch (err) { toast(err.message || String(err), 'error'); }
            finally { btn.disabled = false; }
          } }, a.label))) : null));
    document.body.append(wrap);
    wrap.querySelector('input,textarea,select,button.primary')?.focus();
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
