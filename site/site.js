/* 사이트 공통 동작
   1) 전화번호 — PC에서는 눌러도 전화 앱이 없으므로 '복사'로 처리, 터치 기기에서만 tel: 링크
   2) 스크롤 등장 효과
   움직임을 꺼둔 사용자(prefers-reduced-motion)는 모두 건너뛴다. */
(function () {
  var reduced = window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia &&
               window.matchMedia('(pointer: coarse)').matches;

  /* ── 토스트 ─────────────────────────── */
  var toastEl, toastTimer;
  function toast(html) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = html;
    // 다시 띄울 때 애니메이션이 재생되도록 한 프레임 쉬어 간다
    requestAnimationFrame(function () { toastEl.classList.add('is-on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2400);
  }

  function nudge(el) {
    if (reduced) return;
    el.classList.remove('is-nudging');
    void el.offsetWidth;             // 애니메이션 재시작을 위한 강제 리플로우
    el.classList.add('is-nudging');
    setTimeout(function () { el.classList.remove('is-nudging'); }, 520);
  }

  /* ── 1. 전화번호 ────────────────────── */
  var nums = [].slice.call(document.querySelectorAll('.telno'));

  if (coarse) {
    // 휴대폰·태블릿: 눌러서 바로 전화가 걸리도록 링크로 승격
    nums.forEach(function (el) {
      var a = document.createElement('a');
      a.href = 'tel:' + (el.getAttribute('data-tel') || el.textContent).replace(/[^0-9+]/g, '');
      a.className = el.className;
      a.setAttribute('style', el.getAttribute('style') || '');
      a.innerHTML = el.innerHTML;
      el.parentNode.replaceChild(a, el);
    });
  } else {
    // PC: 누르면 번호를 복사해 준다. 아무 반응 없이 끝나지 않게.
    nums.forEach(function (el) {
      el.style.cursor = 'pointer';
      el.setAttribute('title', '눌러서 번호 복사');
      el.addEventListener('click', function () {
        var num = (el.getAttribute('data-tel') || el.textContent).replace(/[^0-9]/g, '');
        var pretty = num.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
        var done = function () { toast('전화번호를 복사했어요 · <b>' + pretty + '</b>'); };
        var fail = function () { nudge(el); toast('직접 눌러서 복사해 주세요 · <b>' + pretty + '</b>'); };

        // 구형·제한 환경용 예비 복사(숨긴 입력칸을 골라 복사)
        function legacyCopy() {
          try {
            var ta = document.createElement('textarea');
            ta.value = pretty;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
          } catch (e) { return false; }
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(pretty).then(done)['catch'](function () {
            legacyCopy() ? done() : fail();
          });
        } else {
          legacyCopy() ? done() : fail();
        }
      });
    });
  }

  /* ── 2. 스크롤 등장 ─────────────────── */
  if (reduced || !('IntersectionObserver' in window)) return;

  // ★숨기기 전에 반드시 확인할 것: 이 탭이 지금 보이는 상태인가.
  // 백그라운드 탭(카톡에서 새 탭으로 열기 등)에서는 브라우저가
  // IntersectionObserver를 돌리지 않아, 숨겨만 놓고 영영 못 띄운다.
  // 그래서 보이지 않는 동안에는 아예 손대지 않고, 보이는 순간 시작한다.
  if (document.hidden) {
    document.addEventListener('visibilitychange', function once() {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', once);
      startReveal();
    });
    return;
  }
  startReveal();

  function startReveal() {
  var targets = [].slice.call(document.querySelectorAll(
    '.sec-head, .card, .fl-item, .yr, .chip, .shot, .app-card, ' +
    '.price-card, .lead-shot, .inst, .rule, .mistake, .step, .prize, ' +
    '.proof-stats > div, .photo-slot, .faq details, .sheet'
  ));
  if (!targets.length) return;

  targets.forEach(function (el) { el.classList.add('reveal'); });

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      // 같은 줄에 나란한 것들은 아주 살짝 시차를 둬 순서대로 올라오게
      var sibs = e.target.parentNode ? [].slice.call(e.target.parentNode.children) : [];
      var i = Math.min(sibs.indexOf(e.target), 5);
      e.target.style.setProperty('--d', (i > 0 ? i * 70 : 0) + 'ms');
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

  targets.forEach(function (el) { io.observe(el); });

  // 안전장치 — 관찰이 어떤 이유로든 동작하지 않으면 내용이 영영 숨겨진다.
  // 2.5초 뒤, 화면에 들어와 있는데도 아직 숨어 있는 것은 무조건 띄운다.
  setTimeout(function () {
    [].slice.call(document.querySelectorAll('.reveal:not(.is-in)')).forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 1.2) el.classList.add('is-in');
    });
  }, 2500);
  }
})();
