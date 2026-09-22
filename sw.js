// オフラインでも起動できるようにアプリ本体をキャッシュする。
// 更新がすぐ反映されるよう、まずネットワークを見て、繋がらない時だけキャッシュを使う。

const CACHE = 'music-tap-game-v7';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/main.js',
  'js/audio.js',
  'js/game.js',
  'js/input.js',
  'js/renderer.js',
  'js/storage.js',
  'js/soviet.js',
  'js/chart/analyze.js',
  'js/chart/fft.js',
  'js/chart/generate.js',
  'js/chart/worker.js',
  'songs/index.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  // GitHub Pages は 10 分間ブラウザにキャッシュさせるので、そのままだと更新直後に
  // 新しい HTML と古い JS が混ざる。毎回サーバーに更新の有無を確かめる(変わっていなければ 304 で軽い)。
  const fresh = request.mode === 'navigate' ? fetch(request.url, { cache: 'no-cache' }) : fetch(request, { cache: 'no-cache' });
  e.respondWith(
    fresh
      .then((res) => {
        if (res.ok && new URL(request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html'))),
  );
});
