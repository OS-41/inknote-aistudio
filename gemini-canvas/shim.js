/*
 * 手書きノート — Gemini Canvas 版の接続部品（shim）
 * Gemini の Canvas の中では、Gemini API を API キーなしで呼べ（Canvas がログイン中の利用者の Gemini として処理する）、
 * Firestore のデータベースも用意される。それらをアプリ本体の window.__inknote.use(...) につなぐ。
 * 起動情報（Firebase の設定など）は、Canvas に貼る loader.html が window.__INKNOTE_CANVAS に入れて渡す。
 */
(function () {
  'use strict';
  const C = window.__INKNOTE_CANVAS || {};
  const api = window.__inknote = window.__inknote || {};
  let resolveReady;
  api.ready = new Promise(r => { resolveReady = r; });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});
  const FB = 'https://www.gstatic.com/firebasejs/11.6.1/';
  let F = null, A = null, fsdb = null, auth = null, uid = null;
  const appId = String(C.appId || 'default-app-id').replace(/[^\w.-]/g, '_');
  const col = name => F.collection(fsdb, 'artifacts', appId, 'users', uid, name);
  const ref = (name, id) => F.doc(fsdb, 'artifacts', appId, 'users', uid, name, id);

  /* ---------- 画面部品 ---------- */
  const CSS = `
  #ink-ai,#ink-msg{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(30,30,30,.35);font-family:"Zen Kaku Gothic New",system-ui,sans-serif;color:#222}
  #ink-ai .card,#ink-msg .card{width:min(440px,92vw);max-height:90vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:20px}
  #ink-ai h2,#ink-msg h2{font-size:18px;margin:0 0 8px}
  #ink-ai p,#ink-msg p{font-size:12.5px;color:#666;line-height:1.6;margin:0 0 10px}
  #ink-ai label{display:block;margin-top:10px}
  #ink-ai label>span{display:block;font-size:12px;color:#555;margin-bottom:3px}
  #ink-ai input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #cfc8b8;border-radius:8px;font:inherit;font-size:15px;color:#111;background:#fff}
  #ink-ai .btns,#ink-msg .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap}
  #ink-ai button,#ink-msg button{padding:8px 14px;border:1px solid #cfc8b8;border-radius:8px;background:#fff;font:inherit;font-size:14px;cursor:pointer;color:#222}
  #ink-ai button.pri{background:#2f5fa8;border-color:#2f5fa8;color:#fff}
  #ink-ai .msg{font-size:12.5px;margin-top:8px;min-height:1em;white-space:pre-wrap}`;
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const k in attrs) { if (k === 'text') e.textContent = attrs[k]; else if (k.startsWith('on')) e[k] = attrs[k]; else e.setAttribute(k, attrs[k]); } e.append(...kids.filter(Boolean)); return e; };
  function css() { if (!document.getElementById('ink-css')) { const s = document.createElement('style'); s.id = 'ink-css'; s.textContent = CSS; document.head.append(s); } }
  function showMessage(title, text) { css(); const w = el('div', { id: 'ink-msg' }, el('div', { class: 'card' }, el('h2', { text: title }), el('p', { text }), el('div', { class: 'btns' }, el('button', { text: '閉じる', onclick: () => w.remove() })))); document.body.append(w); }

  /* ---------- Gemini（Canvas が API キーを補う） ---------- */
  const MODELS = ['gemini-2.5-flash-preview-09-2025', 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.8-flash'];
  const PREF = 'inknote:canvas-ai';
  const prefs = () => { try { return JSON.parse(localStorage.getItem(PREF) || '{}') || {}; } catch { return {}; } };
  const savePrefs = p => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch {} };
  async function callGemini(body, opts = {}) {
    const p = prefs();
    const list = [...new Set([opts.model, p.model, p.working, ...MODELS].filter(Boolean))];
    let lastErr = null;
    for (const model of list) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let r;
        try {
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${C.apiKey || ''}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: opts.signal,
          });
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          lastErr = err('unavailable', 'Gemini に接続できませんでした（' + ((e && e.message) || 'ネットワークエラー') + '）'); break;
        }
        const txt = await r.text();
        let d = null; try { d = JSON.parse(txt); } catch {}
        if (r.ok) {
          if (p.working !== model) savePrefs({ ...prefs(), working: model });
          return { d, model };
        }
        const msg = (d && d.error && d.error.message) || txt.slice(0, 300);
        if ((r.status === 429 || r.status === 503 || r.status === 500) && attempt < 2) { await sleep(attempt ? 12000 : 5000); continue; }
        if (r.status === 404 || (r.status === 400 && /model/i.test(msg))) { lastErr = err('ai_model', `モデル ${model} が使えません`); break; }   // 次のモデルを試す
        if (r.status === 429) throw err('rate_limited', 'Gemini の利用上限に達したか、混み合っています。少し待ってから再試行してください\n［gemini］' + msg);
        if (r.status === 400 && /token|too long|exceed/i.test(msg)) throw err('too_large', '送る内容が長すぎます（ノートや参考資料の範囲を狭めてください）\n［gemini］' + msg);
        throw err('ai_error', `Gemini でエラーが発生しました（${r.status}）\n［gemini］` + msg);
      }
    }
    throw lastErr || err('ai_error', 'Gemini を呼び出せませんでした');
  }
  const textOf = d => { const c = d && d.candidates && d.candidates[0]; return ((c && c.content && c.content.parts) || []).map(x => x.text || '').join(''); };
  function blobToB64(b) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => { const s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); }; fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); }); }
  async function shrinkForAI(b) {
    try {
      if (!/^image\//.test(b.type) || b.type === 'image/svg+xml' || typeof createImageBitmap !== 'function') return b;
      const bmp = await createImageBitmap(b); const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (sc >= 1 && b.size < 900 * 1024) { bmp.close && bmp.close(); return b; }
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
      const out = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85)); return out && out.size < b.size ? out : b;
    } catch { return b; }
  }
  async function ask(prompt, opts = {}) {
    const parts = [];
    for (const im of opts.images || []) {
      if (im instanceof Blob) { const s = await shrinkForAI(im); parts.push({ inlineData: { mimeType: s.type || 'image/jpeg', data: await blobToB64(s) } }); }
      else if (typeof im === 'string' && im.startsWith('data:')) parts.push({ inlineData: { mimeType: im.slice(5, im.indexOf(';')), data: im.slice(im.indexOf(',') + 1) } });
    }
    parts.push({ text: String(prompt) });
    const body = { contents: [{ role: 'user', parts }] };
    if (opts.json) body.generationConfig = { responseMimeType: 'application/json' };
    const p = prefs();
    const { d } = await callGemini(body, { signal: opts.signal, model: opts.modelTier === 'complex' ? p.modelComplex || p.model : p.model });
    const text = textOf(d);
    if (!text) { const fr = d && d.candidates && d.candidates[0] && d.candidates[0].finishReason; throw err('ai_blocked', 'Gemini が応答を返しませんでした' + (fr ? `（${fr}）` : '')); }
    if (typeof opts.onText === 'function') { try { opts.onText({ text }); } catch {} }
    return { text };
  }
  function parseJSON(text) {
    let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
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

  /* ---------- Web（Gemini の URL 読み取り・Google 検索を使う） ---------- */
  async function webFetch(input, signal) {
    const urls = (Array.isArray(input.urls) ? input.urls : [input.url]).filter(u => typeof u === 'string').slice(0, 3);
    const results = [], errors = [];
    for (const url of urls) {
      try {
        const { d } = await callGemini({
          contents: [{ role: 'user', parts: [{ text: `次の URL のページを読み、本文をできるだけ省略せずにそのまま書き出してください。最初の行にページのタイトルを「# タイトル」の形で書いてください。見出し・箇条書き・表は Markdown で残してください。\nURL: ${url}` }] }],
          tools: [{ url_context: {} }],
        }, { signal });
        const t = textOf(d); const m = t.match(/^#\s*(.+)$/m);
        if (t.trim()) results.push({ url, title: m ? m[1].trim() : url, full_content: t }); else errors.push({ url, error_type: 'empty', message: 'ページを読み取れませんでした' });
      } catch (e) { if (e && e.name === 'AbortError') throw e; errors.push({ url, error_type: e.code || 'error', message: e.message }); }
    }
    if (!results.length && errors.length) throw err('fetch_failed', errors[0].message || 'ページを取得できませんでした');
    return { results, errors };
  }
  async function webSearch(input, signal) {
    const qs = (Array.isArray(input.search_queries) ? input.search_queries : []).filter(Boolean).slice(0, 5);
    const { d } = await callGemini({
      contents: [{ role: 'user', parts: [{ text: `次の目的に合う、信頼できる Web ページを Google 検索で探し、各ページの要点を日本語で短くまとめてください。\n目的: ${input.objective || qs[0] || ''}${qs.length ? '\n検索語: ' + qs.join(' / ') : ''}` }] }],
      tools: [{ google_search: {} }],
    }, { signal });
    const c = (d && d.candidates && d.candidates[0]) || {}; const gm = c.groundingMetadata || {};
    const chunks = gm.groundingChunks || []; const ex = chunks.map(() => []);
    for (const s of gm.groundingSupports || []) for (const i of s.groundingChunkIndices || []) if (ex[i] && s.segment && s.segment.text) ex[i].push(s.segment.text);
    const text = textOf(d);
    const results = chunks.map((ch, i) => ch.web ? { url: ch.web.uri, title: ch.web.title || ch.web.uri, excerpts: ex[i].length ? ex[i] : [text.slice(0, 600)] } : null).filter(Boolean);
    if (!results.length && text) results.push({ url: '', title: 'Gemini による検索結果の要約', excerpts: [text] });
    return { results };
  }

  /* ---------- 保存（Firestore：artifacts/{appId}/users/{uid}/…） ---------- */
  const wrapErr = e => { const c = String((e && e.code) || ''); if (/permission/.test(c)) return err('permission_denied', 'データベースへのアクセスが拒否されました'); if (/unavailable|deadline/.test(c)) return err('unavailable', 'データベースに接続できません'); if (/resource-exhausted/.test(c)) return err('rate_limited', 'データベースの利用上限に達しました'); return e; };
  const snapOf = (id, json) => ({ id, exists: json != null, data: () => (json == null ? undefined : JSON.parse(json)) });
  function makeQuery(filters) {
    return {
      where(f, op, v) { return makeQuery([...filters, [f, op, v]]); },
      async get() {
        try {
          const eq = filters.find(([f, op]) => op === '==' && (f === 'kind' || f === 'note'));
          const snap = await F.getDocs(eq ? F.query(col('inknote_docs'), F.where(eq[0], '==', eq[2])) : col('inknote_docs'));
          const out = [];
          snap.forEach(d => { const raw = d.data(); let o; try { o = JSON.parse(raw.json); } catch { return; } if (filters.every(([f, op, v]) => op === '==' ? o[f] === v : op === '!=' ? (o[f] !== undefined && o[f] !== v) : true)) out.push({ id: d.id, json: raw.json }); });
          out.sort((a, b) => (a.id < b.id ? -1 : 1));
          const docs = out.map(x => snapOf(x.id, x.json));
          return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
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
          return {
            id,
            async get() { try { const d = await F.getDoc(ref('inknote_docs', id)); return snapOf(id, d.exists() ? d.data().json : null); } catch (e) { throw wrapErr(e); } },
            async set(data) {
              const json = JSON.stringify(data);
              if (json.length > 900000) throw err('too_large', 'データが大きすぎます');
              try { await F.setDoc(ref('inknote_docs', id), { json, kind: typeof data.kind === 'string' ? data.kind : null, note: typeof data.note === 'string' ? data.note : null, updated: Date.now() }); } catch (e) { throw wrapErr(e); }
            },
            async delete() { try { await F.deleteDoc(ref('inknote_docs', id)); } catch (e) { throw wrapErr(e); } },
          };
        },
      };
    },
  };

  /* ---------- 画像：Firestore に分割保存し、表示は blob: URL に置き換える ---------- */
  // アプリ本体は画像を "/_blob/<id>" という URL で扱う。Canvas にはその URL を返すサーバーがないため、
  // 画面上の <img> は blob: URL に差し替え、保存（innerHTML の読み出し）時には元の "/_blob/<id>" に戻す。
  const CHUNK = 700000;
  const objUrl = new Map(), back = new Map(), loading = new Map();
  const newId = () => 'b' + [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
  async function readBlob(id) {
    const meta = await F.getDoc(ref('inknote_blobs', id));
    if (!meta.exists()) return null;
    const m = meta.data(), parts = [];
    for (let i = 0; i < m.chunks; i++) { const c = await F.getDoc(ref('inknote_chunks', id + '_' + i)); parts.push(c.exists() ? c.data().d : ''); }
    const bin = atob(parts.join('')); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: m.type || 'image/jpeg' });
  }
  function urlFor(id) {
    if (objUrl.has(id)) return Promise.resolve(objUrl.get(id));
    if (!loading.has(id)) loading.set(id, readBlob(id).then(b => { if (!b) return null; const u = URL.createObjectURL(b); objUrl.set(id, u); back.set(u, '/_blob/' + id); return u; }).catch(() => null));
    return loading.get(id);
  }
  const blobIdOf = s => { const m = /^(?:https?:\/\/[^/]+)?\/_blob\/(b[0-9a-f]{32})/.exec(String(s || '')); return m ? m[1] : null; };
  const assets = {
    async upload(blob) {
      if (blob.size > 8 * 1024 * 1024) throw err('too_large', '画像が大きすぎます');
      const id = newId(), b64 = await blobToB64(blob), n = Math.ceil(b64.length / CHUNK);
      try {
        const batch = F.writeBatch(fsdb);
        for (let i = 0; i < n; i++) batch.set(ref('inknote_chunks', id + '_' + i), { d: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
        batch.set(ref('inknote_blobs', id), { type: blob.type || 'image/jpeg', size: blob.size, chunks: n, created: Date.now() });
        await batch.commit();
      } catch (e) { throw wrapErr(e); }
      const u = URL.createObjectURL(blob); objUrl.set(id, u); back.set(u, '/_blob/' + id);
      return { id, url: '/_blob/' + id };
    },
  };
  function patchImages() {
    const getAttr = Element.prototype.getAttribute;
    const fix = img => {
      const id = img.dataset && img.dataset.inkBlob ? null : blobIdOf(getAttr.call(img, 'src'));
      if (!id) return;
      img.dataset.inkBlob = id;
      urlFor(id).then(u => { if (u && img.dataset.inkBlob === id) img.setAttribute('src', u); });
    };
    new MutationObserver(ms => {
      for (const m of ms) {
        if (m.type === 'attributes') { const t = m.target; if (t.tagName === 'IMG') { if (t.dataset.inkBlob && blobIdOf(getAttr.call(t, 'src')) && blobIdOf(getAttr.call(t, 'src')) !== t.dataset.inkBlob) delete t.dataset.inkBlob; fix(t); } continue; }
        for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; if (n.tagName === 'IMG') fix(n); else if (n.querySelectorAll) n.querySelectorAll('img').forEach(fix); }
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    document.querySelectorAll('img').forEach(fix);
    // 保存のための読み出しでは "/_blob/<id>" に戻す
    const toPath = s => { if (!back.size || typeof s !== 'string' || s.indexOf('blob:') < 0) return s; for (const [u, p] of back) if (s.includes(u)) s = s.split(u).join(p); return s; };
    for (const prop of ['innerHTML', 'outerHTML']) {
      const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
      Object.defineProperty(Element.prototype, prop, { configurable: true, enumerable: d.enumerable, get() { return toPath(d.get.call(this)); }, set(v) { d.set.call(this, v); } });
    }
    Element.prototype.getAttribute = function (name) { const v = getAttr.call(this, name); return name === 'src' && this.tagName === 'IMG' ? toPath(v) : v; };
    // 書き出しなどで fetch("/_blob/<id>") されたら Firestore から返す
    const ofetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const id = blobIdOf(url) || blobIdOf(back.get(url));
      if (id && fsdb) { const u = await urlFor(id); if (!u) return new Response('Not found', { status: 404 }); return ofetch(u); }
      return ofetch(input, init);
    };
  }

  /* ---------- その他 ---------- */
  const SCHEMAS = { web_fetch: { type: 'object', required: ['urls'], properties: { urls: { type: 'array' } } }, web_search: { type: 'object', required: ['objective'], properties: { objective: { type: 'string' }, search_queries: { type: 'array' } } } };
  const mcp = {
    canSearch: true,
    async describeTool(_s, t) { return { inputSchema: SCHEMAS[t] || null }; },
    async callTool(_s, tool, input, opts = {}) {
      if (tool === 'web_fetch') return { payload: await webFetch(input || {}, opts.signal) };
      if (tool === 'web_search') return { payload: await webSearch(input || {}, opts.signal) };
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
  api.aiLabel = () => { const p = prefs(); return `AI：Gemini（${p.model || p.working || '標準'}）`; };
  api.aiSettings = () => new Promise(resolve => {
    css();
    const p = prefs();
    const mIn = el('input', { type: 'text', placeholder: p.working || MODELS[0], autocapitalize: 'off', spellcheck: 'false' }); mIn.value = p.model || '';
    const cIn = el('input', { type: 'text', placeholder: '空欄ならふだんと同じ', autocapitalize: 'off', spellcheck: 'false' }); cIn.value = p.modelComplex || '';
    const msg = el('div', { class: 'msg' });
    const close = ok => { w.remove(); resolve(ok); };
    const test = async () => {
      msg.style.color = '#555'; msg.textContent = '接続テスト中…';
      try { const { d, model } = await callGemini({ contents: [{ role: 'user', parts: [{ text: '「OK」とだけ返してください。' }] }] }, { model: mIn.value.trim() || undefined }); msg.style.color = '#2e7d32'; msg.textContent = `接続できました（${model}）：${textOf(d).slice(0, 40)}`; }
      catch (e) { msg.style.color = '#c0392b'; msg.textContent = e.message; }
    };
    const w = el('div', { id: 'ink-ai' }, el('div', { class: 'card' },
      el('h2', { text: 'AIの設定（Gemini）' }),
      el('p', { text: 'この版は、Gemini の Canvas の中で、開いている人の Gemini（Google アカウントの利用枠）を使います。API キーは不要です。通常はモデルを空欄のままにしてください。' }),
      el('label', null, el('span', { text: 'モデル（ふだんの処理）' }), mIn),
      el('label', null, el('span', { text: 'モデル（重い処理）' }), cIn),
      msg,
      el('div', { class: 'btns' },
        el('button', { text: '接続テスト', onclick: test }),
        el('button', { text: 'キャンセル', onclick: () => close(false) }),
        el('button', { class: 'pri', text: '保存', onclick: () => { savePrefs({ ...prefs(), model: mIn.value.trim(), modelComplex: cIn.value.trim() }); close(true); } }))));
    document.body.append(w);
  });
  api.logout = null;

  api.use = async name => {
    switch (name) {
      case 'db': return fsdb ? db : null;
      case 'user': return { id: async () => uid };
      case 'sample': return makeSample();
      case 'assets': return fsdb ? assets : null;
      case 'downloads': return downloads;
      case 'mcp': return mcp;
      default: return null;
    }
  };

  /* ---------- 起動 ---------- */
  (async () => {
    patchImages();
    let cfg = C.firebaseConfig;
    try { if (typeof cfg === 'string') cfg = JSON.parse(cfg); } catch { cfg = null; }
    if (!cfg || !cfg.apiKey) {
      showMessage('保存先が使えません', 'Canvas のデータベース設定が見つからなかったため、この端末のブラウザに保存します（Canvas を開き直すと消えることがあります）。');
      resolveReady(false); return;
    }
    try {
      const [app, au, fs] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js')]);
      F = fs; A = au;
      const fbApp = app.initializeApp(cfg);
      auth = au.getAuth(fbApp); fsdb = fs.getFirestore(fbApp);
      if (C.token) await au.signInWithCustomToken(auth, C.token); else await au.signInAnonymously(auth);
      uid = auth.currentUser.uid;
      api.me = { id: uid, name: (auth.currentUser.displayName || 'あなた') };
      resolveReady(true);
    } catch (e) {
      console.error(e);
      fsdb = null;
      showMessage('保存先に接続できませんでした', String((e && e.message) || e) + '\nこの端末のブラウザに保存します。');
      resolveReady(false);
    }
  })();
})();
