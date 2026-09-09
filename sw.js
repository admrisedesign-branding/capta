// Capta — service worker: telas ficam disponíveis offline, API sempre da rede.
const CACHE = 'capta-v3';
const ESSENCIAIS = ['/dashboard.html','/atendimento.html','/funil.html','/inbox.html','/agendamentos.html',
  '/aula-experimental.html','/alunos.html','/gestao.html','/eventos.html','/ajustes.html','/lead-painel.js',
  '/manifest.webmanifest','/icon-192.png','/icon-512.png'];

self.addEventListener('install', e => { self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ESSENCIAIS).catch(() => {}))); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;   // API nunca do cache
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/dashboard.html'))));
});
// aviso do painel (mensagem nova, aula do dia)
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.tipo === 'aviso' && self.registration.showNotification) {
    self.registration.showNotification(d.titulo || 'Capta', {
      body: d.texto || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || 'capta',
      data: { url: d.url || '/dashboard.html' }, renotify: true });
  }
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/dashboard.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) { w.navigate(url); return w.focus(); }
    return clients.openWindow(url);
  }));
});
