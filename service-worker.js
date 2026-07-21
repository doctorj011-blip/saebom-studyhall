// ── 폐기된 서비스 워커 — 자기 등록해제(kill switch) ─────────────────────────
//
// 이 파일은 더 이상 캐시 기능을 하지 않는다. 지금은 남아있는 등록을 스스로
// 정리하고 사라지는 것이 유일한 역할이다.
//
// 사연: 2026-06-27 01:19~02:13(약 54분) 동안 saebom_student.html 이
// './service-worker.js' 를 등록하던 시기가 있었다(커밋 6d3df37 → 9a1fa47).
// 등록 코드는 그때 사라졌지만, 이미 등록된 워커는 코드를 지운다고 해제되지
// 않는다. 그 사이 앱을 연 기기에는 scope '/saebom-studyhall/' 로 워커가
// 아직 살아있고, 학생앱뿐 아니라 학부모앱·관리앱 요청까지 가로챈다.
//
// 파일을 그냥 삭제해 404를 내는 방법은 브라우저마다 해제 동작이 달라
// 보장되지 않는다. 그래서 내용을 이 kill switch 로 갈아끼워, 남은 기기가
// 다음 접속 때 확실히 스스로 정리하도록 한다.
//
// 모든 기기가 한 번씩은 접속했을 시점(2026년 말 이후)에 이 파일을 삭제해도
// 안전하다. 그 전까지는 지우지 말 것 — 지우면 정리가 안 된 기기가 남는다.
//
// ⚠️ detector_sw.js 와 혼동 주의. 그쪽은 drowsiness_detector.html 이 실제로
//    등록해 쓰는 살아있는 파일이다.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 이 워커가 남긴 캐시를 모두 비운다
    await Promise.all((await caches.keys()).map(key => caches.delete(key)));
    // 등록 자체를 해제한다
    await self.registration.unregister();
    // 열려 있던 탭을 새로고침해 워커 없는 상태로 즉시 되돌린다
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.navigate(client.url));
  })());
});

// fetch 핸들러 없음 — 요청을 일절 가로채지 않는다(네트워크 그대로 통과).
