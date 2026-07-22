const CACHE = 'capta-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);

  // nunca intercepta API, outros domínios (Supabase), nem métodos que não sejam GET
  if (e.request.method !== 'GET') return;
  if (u.pathname.startsWith('/api/')) return;
  if (u.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      if (e.request.mode === 'navigate') {
        const home = await caches.match('/index.html');
        if (home) return home;
      }
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<div style="font-family:system-ui;padding:44px 24px;text-align:center;color:#0B1220">' +
        '<h2 style="margin:0 0 8px">Sem conexao</h2>' +
        '<p style="color:#64748B;margin:0 0 20px">Verifique sua internet e tente de novo.</p>' +
        '<button onclick="location.reload()" style="background:#2E5BFF;color:#fff;border:0;padding:12px 22px;border-radius:11px;font-weight:700;font-size:15px">Tentar de novo</button>' +
        '</div>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
  })());
});
