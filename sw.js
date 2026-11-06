'use strict';

const scope = new URL(self.registration.scope);
const prefix = `beat-challenge:${scope.pathname}:`;
const cacheName = prefix + 'v2';
const assets = [
  'index.html', 'style.css', 'app.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
].map(path => new URL(path, scope).href);
const shell = assets[0];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache =>
    cache.addAll(assets.map(url => new Request(url, { cache: 'reload' }))),
  ));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(prefix) && key !== cacheName)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  if (event.request.mode === 'navigate' && [scope.pathname, new URL(shell).pathname].includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(async () => {
      const cache = await caches.open(cacheName);
      return (await cache.match(shell)) || Response.error();
    }));
  } else if (assets.includes(url.href)) {
    event.respondWith(fetch(event.request).catch(async () => {
      const cache = await caches.open(cacheName);
      return (await cache.match(url.href)) || Response.error();
    }));
  }
});
