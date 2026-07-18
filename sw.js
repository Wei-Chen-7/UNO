/* UNO Offline service worker.
   Cache-first so the game runs with zero network after the first visit.
   The web-app manifest and the icons are generated right here at fetch
   time (OffscreenCanvas -> PNG, SVG fallback), so the whole app ships as
   just index.html + sw.js with no binary assets. */
'use strict';

const CACHE = 'uno-offline-v1';
const ASSETS = ['./', './index.html', './sw.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function manifestResponse() {
  const man = {
    name: 'UNO Offline',
    short_name: 'UNO',
    description: 'Single-player UNO vs bots — fully offline',
    start_url: './index.html',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0e1322',
    theme_color: '#0e1322',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
  return new Response(JSON.stringify(man), {
    headers: { 'Content-Type': 'application/manifest+json' }
  });
}

async function iconResponse(size) {
  try {
    const c = new OffscreenCanvas(size, size);
    const x = c.getContext('2d');
    const s = size / 512;
    const r = 96 * s;
    x.beginPath();
    x.moveTo(r, 0);
    x.arcTo(size, 0, size, size, r);
    x.arcTo(size, size, 0, size, r);
    x.arcTo(0, size, 0, 0, r);
    x.arcTo(0, 0, size, 0, r);
    x.closePath();
    x.fillStyle = '#0e1322';
    x.fill();
    x.save();
    x.translate(256 * s, 256 * s);
    x.rotate(-28 * Math.PI / 180);
    x.beginPath();
    x.ellipse(0, 0, 192 * s, 132 * s, 0, 0, Math.PI * 2);
    x.fillStyle = '#e6404b';
    x.fill();
    x.lineWidth = 14 * s;
    x.strokeStyle = '#f6f6f8';
    x.stroke();
    x.fillStyle = '#ffffff';
    x.font = 'italic 900 ' + Math.round(148 * s) + 'px sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('UNO', 0, 6 * s);
    x.restore();
    const blob = await c.convertToBlob({ type: 'image/png' });
    return new Response(blob, { headers: { 'Content-Type': 'image/png' } });
  } catch (err) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
      '<rect width="512" height="512" rx="96" fill="#0e1322"/>' +
      '<g transform="rotate(-28 256 256)">' +
      '<ellipse cx="256" cy="256" rx="192" ry="132" fill="#e6404b" stroke="#f6f6f8" stroke-width="14"/>' +
      '<text x="256" y="272" font-family="sans-serif" font-size="148" font-style="italic" font-weight="900" fill="#fff" text-anchor="middle">UNO</text>' +
      '</g></svg>';
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const file = url.pathname.split('/').pop();
  if (file === 'manifest.webmanifest') { e.respondWith(manifestResponse()); return; }
  const icon = /^icon-(\d+)\.png$/.exec(file);
  if (icon) { e.respondWith(iconResponse(+icon[1])); return; }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok && e.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
