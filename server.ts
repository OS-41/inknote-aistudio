/*
 * 手書きノート — Google AI Studio 版サーバー（Node.js / Express）
 *
 *  - 画面（index.html）を配信（開発時は Vite、公開時は dist/）
 *  - /api/ai          Gemini 呼び出し（GEMINI_API_KEY はサーバー側のシークレット）
 *  - /api/ai/models   使える Gemini モデルの一覧
 *  - /api/web/fetch   URL の本文取得
 *  - /api/web/search  Google 検索（Gemini の Google 検索グラウンディング）
 * ノートや画像の保存は、ブラウザから Firestore に直接行う（firestore.rules で本人のみ読み書き可）。
 * /api はすべて Firebase のログイン（ID トークン）を確認してから処理する。
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { initializeApp as initAdmin } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MODEL_COMPLEX = process.env.GEMINI_MODEL_COMPLEX || 'gemini-2.5-pro';
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 200;
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 16000;

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const bad = (msg: string): never => { throw new HttpError(400, 'bad_request', msg); };

/* ---------- Firebase（AI Studio が作る firebase-applet-config.json を読む） ---------- */
function firebaseConfig(): any {
  for (const f of ['firebase-applet-config.json', 'src/firebase-applet-config.json']) {
    try { return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); } catch {}
  }
  return null;
}
let adminApp: any = null;
function adminAuth() {
  const c = firebaseConfig();
  if (!c || !c.projectId) return null;
  if (!adminApp) adminApp = initAdmin({ projectId: c.projectId }, 'inknote');
  return getAdminAuth(adminApp);
}
async function currentUser(req: express.Request) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) throw new HttpError(401, 'unauthenticated', 'ログインしてください');
  const a = adminAuth();
  if (!a) throw new HttpError(503, 'no_firebase', 'Firebase が設定されていません');
  try { const t = await a.verifyIdToken(m[1]); return { id: t.uid, name: t.name || t.email || 'user' }; }
  catch { throw new HttpError(401, 'unauthenticated', 'ログインの有効期限が切れました。もう一度ログインしてください'); }
}

/* ---------- Gemini ---------- */
let genai: GoogleGenAI | null = null;
function ai() {
  if (!process.env.GEMINI_API_KEY) throw new HttpError(503, 'no_ai', 'GEMINI_API_KEY が設定されていません（AI Studio の Settings → Secrets を確認してください）');
  if (!genai) genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genai;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function geminiError(e: any): HttpError {
  if (e instanceof HttpError) return e;
  const status = Number(e && (e.status || e.code)) || 0;
  let msg = String(e && e.message || e).replace(/AIza[0-9A-Za-z_\-]{20,}/g, '***');
  try { const j = JSON.parse(msg); msg = (j.error && (j.error.status + ': ' + j.error.message)) || msg; } catch {}
  msg = msg.slice(0, 400);
  console.log('gemini error', status, msg);
  const tail = `\n［gemini の応答${status ? ' ' + status : ''}］${msg}`;
  if (status === 429) return new HttpError(429, 'rate_limited', 'Gemini の利用上限に達したか、混み合っています。少し待ってから再試行してください' + tail);
  if (status === 401 || status === 403) return new HttpError(502, 'ai_auth', 'Gemini に拒否されました（APIキーを確認してください）' + tail);
  if (status === 404) return new HttpError(502, 'ai_model', 'モデルが見つかりません（「AIの設定」で選び直してください）' + tail);
  if (status === 400 && /image|mime|inline/i.test(msg)) return new HttpError(400, 'no_images', 'このモデルは画像に対応していない可能性があります' + tail);
  return new HttpError(502, 'ai_error', `Gemini でエラーが発生しました${status ? '（' + status + '）' : ''}` + tail);
}
async function generate(model: string, parts: any[], opts: { json?: boolean; tools?: any[] } = {}) {
  const config: any = { maxOutputTokens: MAX_TOKENS };
  if (opts.json) config.responseMimeType = 'application/json';
  if (opts.tools) config.tools = opts.tools;
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai().models.generateContent({ model, contents: [{ role: 'user', parts }], config });
    } catch (e: any) {
      const st = Number(e && (e.status || e.code)) || 0;
      // 一時的な混雑は少し待って最大2回まで再試行（1日の上限は除く）
      if ((st === 429 || st === 500 || st === 503) && attempt < 2 && !/per.?day|daily/i.test(String(e && e.message))) { await sleep(attempt ? 12000 : 5000); continue; }
      throw geminiError(e);
    }
  }
}
const cleanModel = (v: any) => (typeof v === 'string' && /^[\w.\-\/]{1,100}$/.test(v.trim()) ? v.trim() : '');

// 1日の回数制限（ユーザーごと。サーバーの再起動でリセットされる簡易なもの）
const usage = new Map<string, number>();
function countUse(uid: string) {
  const key = new Date().toISOString().slice(0, 10) + ':' + uid;
  const n = usage.get(key) || 0;
  if (n >= DAILY_LIMIT) throw new HttpError(429, 'daily_limit', `今日のAI利用回数の上限（${DAILY_LIMIT}回）に達しました。明日またお使いください`);
  usage.set(key, n + 1);
  if (usage.size > 5000) for (const k of usage.keys()) if (!k.startsWith(key.slice(0, 10))) usage.delete(k);
}

/* ---------- 応答の送り方 ---------- */
// 時間のかかる処理は、すぐに応答を始めて10秒ごとに空白を送る（iPad Safari などの無通信切断を防ぐ）。
// エラーは本文の {"error": {...}} で返す（画面側の shim が通常のエラーとして扱う）。
async function streamJSON(res: express.Response, work: () => Promise<any>) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  res.write(' ');
  const ka = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
  try { res.end(JSON.stringify(await work())); }
  catch (e: any) {
    const er = e instanceof HttpError ? e : geminiError(e);
    res.end(JSON.stringify({ error: { status: er.status, code: er.code, message: er.message } }));
  } finally { clearInterval(ka); }
}
const handler = (fn: (req: express.Request, res: express.Response) => Promise<any>) => async (req: express.Request, res: express.Response) => {
  try { await fn(req, res); }
  catch (e: any) {
    const er = e instanceof HttpError ? e : new HttpError(500, 'internal', 'サーバー内部でエラーが発生しました');
    if (!(e instanceof HttpError)) console.log('error', e && e.stack || e);
    if (!res.headersSent) res.status(er.status).json({ code: er.code, message: er.message });
  }
};

/* ---------- Web ---------- */
function checkUrl(u) {
  let url; try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith('[')) return null;
  return url;
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·', yen: '¥' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEntities(tm[1]).replace(/\s+/g, ' ').trim() : '';
  let body = html;
  const main = html.match(/<(article|main)\b[^>]*>([\s\S]*)<\/\1>/i);
  if (main && main[2].length > 1500) body = main[2];
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form|button|select)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|main|header|li|ul|ol|table|tr|h[1-6]|blockquote|pre|dd|dt|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  body = decodeEntities(body).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: body };
}
function decodeBody(buf, contentType) {
  let cs = (/charset=([^;]+)/i.exec(contentType || '') || [])[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
    cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  cs = (cs || 'utf-8').trim().toLowerCase();
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}
async function fetchOne(u) {
  const url = checkUrl(u);
  if (!url) return { error: { url: u, error_type: 'invalid_url', message: 'URLが不正です' } };
  let r;
  try {
    r = await fetch(url.toString(), {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; InkNote/1.0; +https://developers.cloudflare.com/workers/)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'ja,en;q=0.8' },
    });
  } catch (e) { return { error: { url: u, error_type: 'fetch_error', message: 'ページに接続できませんでした' } }; }
  if (!r.ok) return { error: { url: u, error_type: 'http_error', message: `ページを取得できませんでした（${r.status}）` } };
  const ct = r.headers.get('content-type') || '';
  if (!/text\/|xhtml|xml|json/i.test(ct)) return { error: { url: u, error_type: 'unsupported', message: 'HTML 以外のファイル（PDF など）は取得できません' } };
  const buf = new Uint8Array(await r.arrayBuffer()).slice(0, 3 * 1024 * 1024);
  const raw = decodeBody(buf, ct);
  const { title, text } = /html|xml/i.test(ct) ? htmlToText(raw) : { title: '', text: raw };
  return { result: { url: r.url || u, title, full_content: text.slice(0, 300000) } };
}

/* ---------- アプリ ---------- */
const app = express();
app.disable('x-powered-by');
app.use('/api', express.json({ limit: '40mb' }));

app.get('/api/config', (_req, res) => {
  res.set('cache-control', 'no-store').json({
    ai: !!process.env.GEMINI_API_KEY, aiImages: true, search: !!process.env.GEMINI_API_KEY,
    firebase: firebaseConfig(), model: MODEL, modelComplex: MODEL_COMPLEX, dailyLimit: DAILY_LIMIT,
  });
});

const IMG = /^image\/(jpeg|png|gif|webp|heic|heif|avif)$/;
app.post('/api/ai', handler(async (req, res) => {
  const me = await currentUser(req);
  const { prompt, images = [], tier, json } = req.body || {};
  if (typeof prompt !== 'string' || !prompt) bad('プロンプトが空です');
  if (!Array.isArray(images) || images.length > 8) bad('画像が多すぎます');
  for (const im of images) if (!im || typeof im.data !== 'string' || !IMG.test(String(im.type))) bad('画像の形式が不正です');
  ai(); countUse(me.id);
  const model = (tier === 'complex' ? cleanModel(req.body.modelComplex) || cleanModel(req.body.model) || MODEL_COMPLEX : cleanModel(req.body.model) || MODEL);
  const parts: any[] = [...images.map((im: any) => ({ inlineData: { mimeType: im.type, data: im.data } })), { text: prompt }];
  await streamJSON(res, async () => {
    const r: any = await generate(model, parts, { json: !!json });
    const text = r.text ?? '';
    if (!text && r.candidates && r.candidates[0] && r.candidates[0].finishReason && r.candidates[0].finishReason !== 'STOP')
      throw new HttpError(502, 'ai_blocked', `Gemini が応答を返しませんでした（${r.candidates[0].finishReason}）`);
    return { text, provider: 'gemini', model };
  });
}));

app.post('/api/ai/models', handler(async (req, res) => {
  await currentUser(req);
  const ids: string[] = [];
  const pager: any = await ai().models.list({ config: { pageSize: 100 } });
  for await (const m of pager) {
    const name = String(m.name || '').replace(/^models\//, '');
    const acts: string[] = m.supportedActions || [];
    if (/gemini|gemma/.test(name) && (!acts.length || acts.includes('generateContent')) && !/embedding|tts|image-generation|native-audio|live/.test(name)) ids.push(name);
    if (ids.length > 200) break;
  }
  res.json({ models: [...new Set(ids)].sort(), defaults: { model: MODEL, complex: MODEL_COMPLEX } });
}));

app.post('/api/web/fetch', handler(async (req, res) => {
  await currentUser(req);
  const b = req.body || {};
  const urls = (Array.isArray(b.urls) ? b.urls : [b.url]).filter((u: any) => typeof u === 'string').slice(0, 5);
  if (!urls.length) bad('URLがありません');
  await streamJSON(res, async () => {
    const outs = await Promise.all(urls.map(fetchOne));
    return { results: outs.filter((o: any) => o.result).map((o: any) => o.result), errors: outs.filter((o: any) => o.error).map((o: any) => o.error) };
  });
}));

// Gemini の Google 検索グラウンディングで、関連するページを探す
app.post('/api/web/search', handler(async (req, res) => {
  const me = await currentUser(req);
  const b = req.body || {};
  const queries = (Array.isArray(b.search_queries) ? b.search_queries : []).filter((q: any) => typeof q === 'string' && q).slice(0, 5);
  const objective = String(b.objective || queries[0] || '').slice(0, 2000);
  if (!objective) bad('検索の目的がありません');
  ai(); countUse(me.id);
  await streamJSON(res, async () => {
    const r: any = await generate(MODEL, [{ text: `次の目的に合う、信頼できるWebページを Google 検索で探し、各ページの要点を日本語で短くまとめてください。\n目的: ${objective}${queries.length ? '\n検索語: ' + queries.join(' / ') : ''}` }], { tools: [{ googleSearch: {} }] });
    const gm = (r.candidates && r.candidates[0] && r.candidates[0].groundingMetadata) || {};
    const chunks: any[] = gm.groundingChunks || [];
    const ex: string[][] = chunks.map(() => []);
    for (const s of gm.groundingSupports || []) for (const i of s.groundingChunkIndices || []) if (ex[i] && s.segment && s.segment.text) ex[i].push(s.segment.text);
    const results = chunks.map((c, i) => c.web ? { url: c.web.uri, title: c.web.title || c.web.domain || c.web.uri, excerpts: ex[i].length ? ex[i] : [String(r.text || '').slice(0, 600)] } : null).filter(Boolean);
    return { results, summary: r.text || '' };
  });
}));

app.all('/api/*', (_req, res) => { res.status(404).json({ code: 'not_found', message: '見つかりません' }); });
// 画像（/_blob/…）はブラウザの Service Worker（public/sw.js）が Firestore から読み出して返す。ここに届くのは Service Worker が動いていないとき
app.get('/_blob/*', (_req, res) => { res.status(404).type('text/plain').send('Service Worker が有効になっていないため画像を表示できません。ページを再読み込みしてください。'); });

async function start() {
  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' ? undefined : false }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.resolve('dist');
    app.use(express.static(dist, { index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`inknote: http://localhost:${PORT}`));
}
start();
