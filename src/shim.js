/*
 * 手書きノート — Google AI Studio 版の接続部品（shim）
 * アプリ本体が使う window.__inknote.use(...) を、Firebase（Firestore・Google ログイン）と
 * このアプリのサーバー（/api/...：Gemini・URL 取得・Google 検索）で提供する。
 */
import {
  initializeApp, getAuth, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, signOut,
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, where, getDocs, writeBatch,
} from './firebase.js';

const api = window.__inknote || (window.__inknote = {});
let resolveReady;
if (!api.ready) api.ready = new Promise(r => { resolveReady = r; });
else resolveReady = api._resolve || (() => {});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});
let cfg = null, auth = null, fsdb = null, user = null;

/* ---------- HTTP（/api はログインのトークン付き） ---------- */
async function req(path, { method = 'POST', body, signal } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = 'Bearer ' + await user.getIdToken();
  let r;
  try { r = await fetch(path, { method, signal, headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw err('unavailable', `サーバーに接続できませんでした（${(e && e.message) || 'ネットワークエラー'}）。通信状態を確認して、もう一度お試しください`);
  }
  let data = null;
  try { data = JSON.parse(await r.text()); } catch {}
  if (r.ok && data && data.error && typeof data.error === 'object') throw err(data.error.code || 'error', data.error.message || 'エラーが発生しました', { status: data.error.status });
  if (!r.ok) {
    const code = (data && data.code) || (r.status === 429 ? 'rate_limited' : r.status === 401 ? 'unauthenticated' : r.status >= 500 ? 'unavailable' : 'error');
    throw err(code, (data && data.message) || `サーバーエラー（${r.status}）`, { status: r.status });
  }
  return data;
}

/* ---------- 画面部品（ログイン・AIの設定） ---------- */
const CSS = `
#ink-login,#ink-ai{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;font-family:"Zen Kaku Gothic New",system-ui,sans-serif;color:#222}
#ink-login{background:rgba(244,241,234,.97)}
#ink-ai{background:rgba(30,30,30,.35)}
#ink-login .card,#ink-ai .card{width:min(420px,92vw);max-height:90vh;overflow:auto;background:#fff;border:1px solid #d8d2c4;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.1);padding:22px}
#ink-login h1,#ink-ai h2{font-size:20px;margin:0 0 6px}
#ink-login .sub,.ink-note{font-size:12px;color:#777;margin:0 0 14px;line-height:1.6}
#ink-login .g{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px;border:1px solid #cfc8b8;border-radius:10px;background:#fff;font:inherit;font-size:15px;cursor:pointer;color:#222}
#ink-login .g:disabled{opacity:.6}
#ink-login .msg,#ink-ai .msg{min-height:18px;font-size:12.5px;color:#c0392b;margin-top:10px;white-space:pre-wrap}
#ink-ai label{display:block;margin-top:10px}
#ink-ai label>span{display:block;font-size:12px;color:#555;margin-bottom:3px}
#ink-ai input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #cfc8b8;border-radius:8px;font:inherit;font-size:15px;color:#111;background:#fff}
#ink-ai .row{display:flex;gap:8px}
#ink-ai .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap}
#ink-ai button{padding:8px 14px;border:1px solid #cfc8b8;border-radius:8px;background:#fff;font:inherit;font-size:14px;cursor:pointer;color:#222}
#ink-ai button.pri{background:#2f5fa8;border-color:#2f5fa8;color:#fff}`;
function css() { if (!document.getElementById('ink-css')) { const s = document.createElement('style'); s.id = 'ink-css'; s.textContent = CSS; document.head.append(s); } }
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const k in attrs) { if (k === 'text') e.textContent = attrs[k]; else if (k.startsWith('on')) e[k] = attrs[k]; else e.setAttribute(k, attrs[k]); } e.append(...kids.filter(Boolean)); return e; };
const onBody = fn => document.body ? fn() : document.addEventListener('DOMContentLoaded', fn, { once: true });

function showMessage(title, text) {
  onBody(() => { css(); document.body.append(el('div', { id: 'ink-login' }, el('div', { class: 'card' }, el('h1', { text: title }), el('p', { class: 'sub', text }), el('button', { class: 'g', text: 'この端末だけで使う（保存はこのブラウザ）', onclick: e => { e.target.closest('#ink-login').remove(); } })))); });
}

let loginShown = null;
function showLogin(message) {
  if (loginShown) return loginShown;
  loginShown = new Promise(resolve => onBody(() => {
    css();
    const msg = el('div', { class: 'msg', text: message || '' });
    const go = el('button', { class: 'g' }, el('span', { text: 'G' }), el('span', { text: 'Google でログイン' }));
    go.onclick = async () => {
      go.disabled = true; msg.textContent = '';
      try { await signInWithPopup(auth, new GoogleAuthProvider()); }
      catch (e) {
        const c = String(e && e.code || '');
        if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(c)) { try { await signInWithRedirect(auth, new GoogleAuthProvider()); return; } catch (e2) { e = e2; } }
        if (!/popup-closed|cancelled-popup/.test(c)) msg.textContent = 'ログインできませんでした：' + ((e && e.message) || c);
      } finally { go.disabled = false; }
    };
    const wrap = el('div', { id: 'ink-login' }, el('div', { class: 'card' },
      el('h1', { text: '手書きノート' }),
      el('p', { class: 'sub', text: 'Google アカウントでログインして使います。ノートはあなた専用の場所に保存され、ほかの人からは見えません。' }),
      go, msg));
    document.body.append(wrap);
    const off = onAuthStateChanged(auth, u => { if (u) { off(); wrap.remove(); loginShown = null; resolve(u); } });
  }));
  return loginShown;
}

/* ---------- AI の設定（モデルの選択。この端末に保存） ---------- */
const AI_KEY = 'inknote:ai-gemini';
const aiPrefs = () => { try { return JSON.parse(localStorage.getItem(AI_KEY) || '{}') || {}; } catch { return {}; } };
api.aiLabel = () => { const p = aiPrefs(); return `AI：Gemini（${p.model || (cfg && cfg.model) || '標準'}）`; };
api.aiSettings = () => new Promise(resolve => {
  css();
  const p = aiPrefs();
  const mIn = el('input', { type: 'text', list: 'ink-models', placeholder: cfg.model, autocapitalize: 'off', spellcheck: 'false' }); mIn.value = p.model || '';
  const cIn = el('input', { type: 'text', list: 'ink-models', placeholder: cfg.modelComplex, autocapitalize: 'off', spellcheck: 'false' }); cIn.value = p.modelComplex || '';
  const dl = el('datalist', { id: 'ink-models' });
  const msg = el('div', { class: 'msg' });
  const close = ok => { wrap.remove(); resolve(ok); };
  const list = async () => {
    msg.style.color = '#555'; msg.textContent = 'モデルの一覧を取得中…';
    try { const r = await req('/api/ai/models', { body: {} }); dl.textContent = ''; for (const m of r.models || []) dl.append(el('option', { value: m })); msg.textContent = `${(r.models || []).length} 個のモデルが見つかりました。入力欄をタップすると候補が出ます。`; }
    catch (e) { msg.style.color = '#c0392b'; msg.textContent = e.message; }
  };
  const test = async () => {
    msg.style.color = '#555'; msg.textContent = '接続テスト中…';
    try { const r = await req('/api/ai', { body: { prompt: '「OK」とだけ返してください。', model: mIn.value.trim() || undefined } }); msg.style.color = '#2e7d32'; msg.textContent = `接続できました（${r.model}）：${String(r.text || '').slice(0, 40)}`; }
    catch (e) { msg.style.color = '#c0392b'; msg.textContent = e.message; }
  };
  const wrap = el('div', { id: 'ink-ai' }, el('div', { class: 'card' },
    el('h2', { text: 'AIの設定（Gemini）' }),
    el('p', { class: 'ink-note', text: 'このアプリは Google AI Studio の Gemini を使います。モデルを選べます（空欄なら標準）。設定はこの端末に保存されます。' }), dl,
    el('label', null, el('span', { text: 'モデル（ふだんの処理）' }), el('div', { class: 'row' }, mIn, el('button', { text: '一覧', onclick: e => { e.preventDefault(); list(); } }))),
    el('label', null, el('span', { text: 'モデル（重い処理：画像の解析・本番テスト・添削など）' }), cIn),
    msg,
    el('div', { class: 'btns' },
      el('button', { text: '接続テスト', onclick: test }),
      el('button', { text: 'キャンセル', onclick: () => close(false) }),
      el('button', { class: 'pri', text: '保存', onclick: () => { try { localStorage.setItem(AI_KEY, JSON.stringify({ model: mIn.value.trim(), modelComplex: cIn.value.trim() })); } catch {} close(true); } }))));
  wrap.addEventListener('pointerdown', e => { if (e.target === wrap) close(false); });
  document.body.append(wrap);
});
api.logout = async () => { try { await signOut(auth); } catch {} location.reload(); };

/* ---------- 保存（Firestore：users/{uid}/docs/{id}） ---------- */
// Firestore は入れ子の配列などを保存できないため、中身は JSON 文字列にして保存する
const docsCol = () => collection(fsdb, 'users', user.uid, 'docs');
const wrapErr = e => { if (e && e.code) { const c = String(e.code); if (/unavailable|deadline/.test(c)) return err('unavailable', 'データベースに接続できません'); if (/permission/.test(c)) return err('permission_denied', 'データベースへのアクセスが拒否されました（firestore.rules を確認してください）'); if (/resource-exhausted/.test(c)) return err('rate_limited', 'データベースの利用上限に達しました'); } return e; };
function snapOf(id, json) { return { id, exists: json != null, data: () => (json == null ? undefined : JSON.parse(json)) }; }
function querySnap(list) { const docs = list.map(x => snapOf(x.id, x.json)); return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) }; }
function makeQuery(filters) {
  return {
    where(f, op, v) { return makeQuery([...filters, [f, op, v]]); },
    async get() {
      try {
        // 等号の条件は1つだけ Firestore に任せ、残りはここで絞り込む（複合インデックスを作らなくて済む）
        const eq = filters.find(([f, op]) => op === '==' && (f === 'kind' || f === 'note'));
        const snap = await getDocs(eq ? query(docsCol(), where(eq[0], '==', eq[2])) : docsCol());
        const out = [];
        snap.forEach(d => {
          const raw = d.data(); let obj; try { obj = JSON.parse(raw.json); } catch { return; }
          if (filters.every(([f, op, v]) => op === '==' ? obj[f] === v : op === '!=' ? (obj[f] !== undefined && obj[f] !== v) : true)) out.push({ id: d.id, json: raw.json });
        });
        out.sort((a, b) => (a.id < b.id ? -1 : 1));
        return querySnap(out);
      } catch (e) { throw wrapErr(e); }
    },
  };
}
const db = {
  collection() {
    return {
      ...makeQuery([]),
      doc(id) {
        id = String(id);
        const ref = () => doc(fsdb, 'users', user.uid, 'docs', id);
        return {
          id,
          async get() { try { const d = await getDoc(ref()); return snapOf(id, d.exists() ? d.data().json : null); } catch (e) { throw wrapErr(e); } },
          async set(data) {
            const json = JSON.stringify(data);
            if (json.length > 900000) throw err('too_large', 'データが大きすぎます');
            try { await setDoc(ref(), { json, kind: typeof data.kind === 'string' ? data.kind : null, note: typeof data.note === 'string' ? data.note : null, updated: Date.now() }); } catch (e) { throw wrapErr(e); }
          },
          async delete() { try { await deleteDoc(ref()); } catch (e) { throw wrapErr(e); } },
        };
      },
    };
  },
};

/* ---------- 画像（Firestore：users/{uid}/blobs/{id} と chunks） ---------- */
const CHUNK = 700000;   // base64 の文字数（1ドキュメント 1MiB の上限に収める）
function blobToB64(b) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => { const s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); }; fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); });
}
const assets = {
  async upload(blob) {
    if (blob.size > 8 * 1024 * 1024) throw err('too_large', '画像が大きすぎます');
    const id = 'b' + [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
    const b64 = await blobToB64(blob);
    const n = Math.ceil(b64.length / CHUNK);
    try {
      const batch = writeBatch(fsdb);
      for (let i = 0; i < n; i++) batch.set(doc(fsdb, 'users', user.uid, 'blobs', id, 'chunks', String(i)), { d: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
      batch.set(doc(fsdb, 'users', user.uid, 'blobs', id), { type: blob.type || 'image/jpeg', size: blob.size, chunks: n, created: Date.now() });
      await batch.commit();
    } catch (e) { throw wrapErr(e); }
    blobCache.set(id, { buf: await blob.arrayBuffer(), type: blob.type || 'image/jpeg' });
    return { id, url: '/_blob/' + id };
  },
};
const blobCache = new Map();
async function readBlob(id) {
  if (blobCache.has(id)) { const c = blobCache.get(id); return { buf: c.buf.slice(0), type: c.type }; }
  if (!user || !/^b[0-9a-f]{32}$/.test(id)) return null;
  const meta = await getDoc(doc(fsdb, 'users', user.uid, 'blobs', id));
  if (!meta.exists()) return null;
  const m = meta.data(), parts = [];
  for (let i = 0; i < m.chunks; i++) { const c = await getDoc(doc(fsdb, 'users', user.uid, 'blobs', id, 'chunks', String(i))); parts.push(c.exists() ? c.data().d : ''); }
  const bin = atob(parts.join('')); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  if (blobCache.size > 60) blobCache.delete(blobCache.keys().next().value);
  blobCache.set(id, { buf: a.buffer, type: m.type });
  return { buf: a.buffer.slice(0), type: m.type };
}
// Service Worker（public/sw.js）からの「この画像を読んで」という依頼に答える
async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return false;
  navigator.serviceWorker.addEventListener('message', async ev => {
    if (!ev.data || ev.data.type !== 'inknote-blob' || !ev.ports[0]) return;
    let out = null; try { out = await readBlob(ev.data.id); } catch (e) { console.warn('blob', e); }
    ev.ports[0].postMessage(out, out ? [out.buf] : []);
  });
  try {
    await navigator.serviceWorker.register('/sw.js');
    if (!navigator.serviceWorker.controller) {
      await Promise.race([new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })), sleep(4000)]);
    }
  } catch (e) { console.warn('service worker', e); }
  return !!navigator.serviceWorker.controller;
}

/* ---------- AI ---------- */
async function shrinkForAI(b) {
  try {
    if (!/^image\//.test(b.type) || b.type === 'image/svg+xml' || typeof createImageBitmap !== 'function') return b;
    const bmp = await createImageBitmap(b);
    const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (sc >= 1 && b.size < 900 * 1024) { bmp.close && bmp.close(); return b; }
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
    const out = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    return out && out.size < b.size ? out : b;
  } catch { return b; }
}
async function imagePayload(images) {
  const out = [];
  for (const im of images || []) {
    if (im instanceof Blob) { const s = await shrinkForAI(im); out.push({ type: s.type || 'image/jpeg', data: await blobToB64(s) }); }
    else if (typeof im === 'string' && im.startsWith('data:')) out.push({ type: im.slice(5, im.indexOf(';')), data: im.slice(im.indexOf(',') + 1) });
    else if (im && im.data) out.push(im);
  }
  return out;
}
function parseJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
async function ask(prompt, opts = {}) {
  const p = aiPrefs();
  const r = await req('/api/ai', { body: { prompt: String(prompt), images: await imagePayload(opts.images), tier: opts.modelTier || 'default', json: !!opts.json, model: p.model || undefined, modelComplex: p.modelComplex || undefined }, signal: opts.signal });
  const text = r.text || '';
  if (typeof opts.onText === 'function') { try { opts.onText({ text }); } catch {} }
  return { text };
}
function makeSample() {
  const sample = (prompt, opts) => ask(prompt, opts);
  sample.json = async (prompt, opts = {}) => {
    const r = await ask(prompt + '\n\n（出力は JSON のみ。説明やコードフェンスは付けない）', { ...opts, json: true });
    try { return parseJSON(r.text); } catch { throw err('bad_json', 'AIの出力を解釈できませんでした'); }
  };
  sample.limits = async () => ({ images: true });
  return sample;
}
const SCHEMAS = {
  web_fetch: { type: 'object', required: ['urls'], properties: { urls: { type: 'array' }, full_content: { type: 'boolean' }, objective: { type: 'string' } } },
  web_search: { type: 'object', required: ['objective'], properties: { objective: { type: 'string' }, search_queries: { type: 'array' } } },
};
const mcp = {
  canSearch: true,
  async describeTool(_s, tool) { return { inputSchema: SCHEMAS[tool] || null }; },
  async callTool(_s, tool, input, opts = {}) {
    if (tool === 'web_fetch') return { payload: await req('/api/web/fetch', { body: input, signal: opts.signal }) };
    if (tool === 'web_search') return { payload: await req('/api/web/search', { body: input, signal: opts.signal }) };
    throw err('not_in_manifest', '未対応のツールです');
  },
};
const downloads = {
  async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename || 'download'; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  },
};

api.use = async name => {
  switch (name) {
    case 'db': return db;
    case 'user': return { id: async () => user && user.uid, name: async () => api.me && api.me.name };
    case 'sample': return cfg.ai ? makeSample() : null;
    case 'assets': return assets;
    case 'downloads': return downloads;
    case 'mcp': return mcp;
    default: return null;
  }
};

/* ---------- 起動 ---------- */
(async () => {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    cfg = await r.json();
  } catch { resolveReady(false); return; }
  if (!cfg.firebase || !cfg.firebase.apiKey) {
    showMessage('Firebase が未設定です', 'AI Studio のチャットで「Firebase（Firestore と Google ログイン）を有効にして」と頼んでください（README.md の手順2）。それまではこの端末のブラウザに保存されます。');
    resolveReady(false); return;
  }
  try {
    const app = initializeApp(cfg.firebase);
    auth = getAuth(app);
    fsdb = cfg.firebase.firestoreDatabaseId ? getFirestore(app, cfg.firebase.firestoreDatabaseId) : getFirestore(app);
    try { await getRedirectResult(auth); } catch {}
    user = await new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }); });
    if (!user) user = await showLogin();
    onAuthStateChanged(auth, u => { if (!u && user) location.reload(); });
    api.me = { id: user.uid, name: user.displayName || user.email || 'user' };
    await setupServiceWorker();
    resolveReady(true);
  } catch (e) {
    console.error(e);
    showMessage('起動できませんでした', String((e && e.message) || e));
    resolveReady(false);
  }
})();
