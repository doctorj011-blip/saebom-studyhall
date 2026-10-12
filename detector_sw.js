// ── 폐기된 감지 앱 서비스 워커 — 자기 등록해제(kill switch) ─────────────────
//
// 이 파일은 더 이상 캐시 기능을 하지 않는다. 지금은 남아있는 등록을 스스로
// 정리하고 사라지는 것이 유일한 역할이다.
//
// 사연: drowsiness_detector.html(집중도/졸음 감지 태블릿 앱)이 이 워커를
// './detector_sw.js' 로 등록했다. 2026-08-28 그 기능 전체를 걷어냈지만,
// 이미 등록된 워커는 코드를 지운다고 해제되지 않는다. 감지 앱을 한 번이라도
// 연 기기에는 scope '/saebom-studyhall/' 로 워커가 아직 살아있다.
//
// ★ 이게 특히 위험했던 이유 — 원래 이 워커의 fetch 핸들러는 동일 출처 GET을
//   전부 캐시 우선으로 가로챘다. scope 가 저장소 루트라 감지 앱뿐 아니라
//   학생앱·학부모앱 요청까지 낡은 캐시로 응답한다. 그래서 파일을 그냥
//   삭제하면(404) 해제 동작이 브라우저마다 달라 정리가 보장되지 않는다.
//
// 모든 기기가 한 번씩은 접속했을 시점(2027년 말 이후)에 이 파일을 삭제해도
// 안전하다. 그 전까지는 지우지 말 것 — 지우면 정리가 안 된 기기가 남는다.
//
// ⚠️ service-worker.js 와 혼동 주의. 그쪽은 2026-06-27 학생앱이 잠깐 등록했던
//    워커의 kill switch 로, 같은 이유로 남겨둔 별개의 파일이다.

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
