// 새봄 면학관 감지 앱 · Service Worker
// 앱 셸을 캐싱해 오프라인에서도 화면이 뜨도록 함.
// (MediaPipe/Firebase는 CDN에서 로드되므로 실제 감지·전송에는 네트워크가 필요합니다.)

const CACHE_NAME = 'saebom-detector-v1';
const APP_SHELL = [
  './drowsiness_detector.html',
  './detector_manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // only handle same-origin GET requests; let CDN/Firebase pass through to network
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(()=>{});
          return res;
        })
        .catch(() => cached);
    })
  );
});
