// Device identification used to stop repeat voting.
//
//  device_token : a random id saved in localStorage, a cookie and IndexedDB.
//                 Clearing one store is not enough; it is restored from the others.
//  fingerprint  : a hash of hardware/browser traits (canvas, WebGL, audio, screen,
//                 fonts, timezone...). It stays the same in incognito windows and
//                 after clearing browser data.
//  device_info  : readable details shown to the admin (browser, OS, GPU...).

const KEY = 'vote_device_token';

async function sha256(text) {
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-HTTPS fallback (two 32-bit FNV-1a hashes)
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(text.length - 1 - i), 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') + text.length.toString(16).padStart(8, '0');
}

// ----- persistent token ------------------------------------------------
function idb(mode, value) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('vote_app', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', mode);
        const store = tx.objectStore('kv');
        const r = mode === 'readonly' ? store.get(KEY) : store.put(value, KEY);
        r.onsuccess = () => resolve(mode === 'readonly' ? r.result : value);
        r.onerror = () => resolve(null);
      };
    } catch { resolve(null); }
  });
}

function getCookie() {
  return document.cookie.split('; ').find((c) => c.startsWith(KEY + '='))?.split('=')[1] || null;
}

async function deviceToken() {
  let ls = null;
  try { ls = localStorage.getItem(KEY); } catch {}
  const tok = ls || getCookie() || (await idb('readonly')) ||
    (crypto.randomUUID ? crypto.randomUUID() : (await sha256(Math.random() + ':' + Date.now())).slice(0, 36));
  try { localStorage.setItem(KEY, tok); } catch {}
  document.cookie = `${KEY}=${tok}; max-age=31536000; path=/; SameSite=Lax`;
  await idb('readwrite', tok);
  return tok;
}

// ----- fingerprint signals ----------------------------------------------
function canvasSignal() {
  try {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const x = c.getContext('2d');
    x.textBaseline = 'top';
    x.font = "16px 'Arial'";
    x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20);
    x.fillStyle = '#069'; x.fillText('Vote ✓ Ωπ 😃 1234', 2, 15);
    x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Vote ✓ Ωπ 😃 1234', 4, 17);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = 'rgb(255,0,255)'; x.beginPath(); x.arc(50, 30, 25, 0, Math.PI * 2); x.fill();
    return c.toDataURL();
  } catch { return 'no-canvas'; }
}

function webglSignal() {
  try {
    const gl = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
    if (!gl) return { vendor: 'none', renderer: 'none', params: '' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const params = [gl.MAX_TEXTURE_SIZE, gl.MAX_RENDERBUFFER_SIZE, gl.MAX_VIEWPORT_DIMS, gl.MAX_VERTEX_ATTRIBS,
      gl.MAX_VARYING_VECTORS, gl.ALIASED_LINE_WIDTH_RANGE, gl.ALIASED_POINT_SIZE_RANGE]
      .map((p) => String(gl.getParameter(p))).join('|');
    return { vendor, renderer, params: params + '|' + (gl.getSupportedExtensions() || []).join(',') };
  } catch { return { vendor: 'err', renderer: 'err', params: '' }; }
}

async function audioSignal() {
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return 'no-audio';
    const ctx = new Ctx(1, 5000, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12;
    comp.attack.value = 0; comp.release.value = 0.25;
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    const buf = await Promise.race([ctx.startRendering(), new Promise((r) => setTimeout(() => r(null), 800))]);
    if (!buf) return 'audio-timeout';
    const data = buf.getChannelData(0);
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
    return sum.toFixed(6);
  } catch { return 'audio-err'; }
}

function fontSignal() {
  const fonts = ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Trebuchet MS', 'Comic Sans MS',
    'Impact', 'Tahoma', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Calibri', 'Cambria', 'Ubuntu', 'Noto Sans',
    'San Francisco', 'Menlo', 'Consolas', 'Lucida Console', 'Garamond', 'Palatino', 'Futura', 'Gill Sans'];
  try {
    const c = document.createElement('canvas').getContext('2d');
    const base = ['monospace', 'serif', 'sans-serif'].map((b) => { c.font = `72px ${b}`; return c.measureText('mmmmmmmmmlli10OQ').width; });
    return fonts.filter((f) => ['monospace', 'serif', 'sans-serif'].some((b, i) => {
      c.font = `72px '${f}', ${b}`;
      return c.measureText('mmmmmmmmmlli10OQ').width !== base[i];
    })).join(',');
  } catch { return ''; }
}

function parseUA(ua) {
  const browser =
    /Edg\/([\d.]+)/.test(ua) ? 'Edge ' + RegExp.$1 :
    /OPR\/([\d.]+)/.test(ua) ? 'Opera ' + RegExp.$1 :
    /SamsungBrowser\/([\d.]+)/.test(ua) ? 'Samsung Internet ' + RegExp.$1 :
    /FBAN|FBAV/.test(ua) ? 'Facebook in-app' :
    /Instagram/.test(ua) ? 'Instagram in-app' :
    /Firefox\/([\d.]+)/.test(ua) ? 'Firefox ' + RegExp.$1 :
    /CriOS\/([\d.]+)/.test(ua) ? 'Chrome iOS ' + RegExp.$1 :
    /Chrome\/([\d.]+)/.test(ua) ? 'Chrome ' + RegExp.$1 :
    /Version\/([\d.]+).*Safari/.test(ua) ? 'Safari ' + RegExp.$1 : 'Unknown';
  const os =
    /Windows NT 10/.test(ua) ? 'Windows 10/11' :
    /Windows NT ([\d.]+)/.test(ua) ? 'Windows ' + RegExp.$1 :
    /Android ([\d.]+)/.test(ua) ? 'Android ' + RegExp.$1 :
    /(iPhone|iPad|iPod).*OS ([\d_]+)/.test(ua) ? RegExp.$1 + ' iOS ' + RegExp.$2.replace(/_/g, '.') :
    /Mac OS X ([\d_]+)/.test(ua) ? 'macOS ' + RegExp.$1.replace(/_/g, '.') :
    /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  const model = /Android [\d.]+; ([^;)]+)/.test(ua) ? RegExp.$1.trim() : null;
  const type = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobi|iPhone|Android/.test(ua) ? 'Phone' : 'Desktop / Laptop';
  return { browser, os, model, type };
}

async function privateModeGuess() {
  try {
    if (navigator.storage?.estimate) {
      const { quota } = await navigator.storage.estimate();
      // Chrome incognito caps the quota far below normal mode.
      if (quota && quota < 200 * 1024 * 1024) return true;
    }
  } catch {}
  return false;
}

let cached = null;

export function getDevice() {
  return (cached ||= (async () => {
    const ua = navigator.userAgent;
    const gl = webglSignal();
    const [audio, token, privateMode] = await Promise.all([audioSignal(), deviceToken(), privateModeGuess()]);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const scr = `${screen.width}x${screen.height}x${screen.colorDepth}@${window.devicePixelRatio}`;

    // Only stable traits go into the fingerprint (no browser version, no window size),
    // so it survives updates and incognito mode.
    const traits = [
      navigator.platform, navigator.hardwareConcurrency, navigator.deviceMemory, navigator.maxTouchPoints,
      scr, tz, new Date().getTimezoneOffset(), gl.vendor, gl.renderer, gl.params, audio,
      await sha256(canvasSignal()), fontSignal(), (navigator.languages || []).join(','),
    ].join('§');
    const fingerprint = await sha256(traits);
    const { browser, os, model, type } = parseUA(ua);

    return {
      fingerprint,
      device_token: token,
      user_agent: ua,
      webdriver: !!navigator.webdriver || /HeadlessChrome|PhantomJS|Puppeteer/i.test(ua),
      device_info: {
        browser, os, model, type,
        screen: scr,
        cores: navigator.hardwareConcurrency || null,
        memory_gb: navigator.deviceMemory || null,
        touch_points: navigator.maxTouchPoints || 0,
        gpu: gl.renderer,
        timezone: tz,
        language: navigator.language,
        private_mode_guess: privateMode,
      },
    };
  })());
}
