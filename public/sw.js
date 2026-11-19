/*
 * 画像（/_blob/<id>）を返す Service Worker。
 * 画像は Firestore に保存されているので、開いているページに読み出しを頼み、結果を返す。
 * 一度読んだ画像はこの端末のキャッシュに入れ、次からは Firestore を読まない。
 */
const CACHE = 'inknote-blobs-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin || !u.pathname.startsWith('/_blob/') || e.request.method !== 'GET') return;
  e.respondWith(serve(e, decodeURIComponent(u.pathname.slice(7))));
});
async function serve(e, id) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match('/_blob/' + id);
  if (hit) return hit;
  let client = e.clientId ? await self.clients.get(e.clientId) : null;
  if (!client) client = (await self.clients.matchAll({ type: 'window' }))[0];
  if (!client) return new Response('No page', { status: 503 });
  const ch = new MessageChannel();
  const got = new Promise(res => { ch.port1.onmessage = ev => res(ev.data); setTimeout(() => res(null), 30000); });
  client.postMessage({ type: 'inknote-blob', id }, [ch.port2]);
  const d = await got;
  if (!d || !d.buf) return new Response('Not found', { status: 404 });
  const resp = new Response(d.buf, { headers: { 'content-type': d.type || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' } });
  try { await cache.put('/_blob/' + id, resp.clone()); } catch {}
  return resp;
}
