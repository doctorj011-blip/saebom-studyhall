/* 전화번호 처리 — PC에서는 번호만 보여주고, 터치 기기에서만 걸리는 링크로 바꾼다.
   데스크톱 브라우저에서 tel: 을 누르면 '앱 선택' 창이 떠서 방해만 되기 때문.
   마크업은 <span class="telno">031-273-0982</span> 로 두고, 여기서 필요할 때만 승격한다. */
(function () {
  var nums = document.querySelectorAll('.telno');
  if (!nums.length) return;

  // 손가락으로 누르는 기기(휴대폰·태블릿)에서만 전화 링크로 만든다.
  var canCall = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!canCall) return;

  nums.forEach(function (el) {
    var a = document.createElement('a');
    a.href = 'tel:' + (el.getAttribute('data-tel') || el.textContent).replace(/[^0-9+]/g, '');
    a.className = el.className;
    a.setAttribute('style', el.getAttribute('style') || '');
    a.innerHTML = el.innerHTML;
    el.parentNode.replaceChild(a, el);
  });
})();
