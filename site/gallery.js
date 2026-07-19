/* 갤러리 라이트박스 — .shot 버튼을 누르면 원본을 크게 본다.
   마크업 쪽 요구사항: 각 .shot 안에 <img>, 캡션은 .shot-label 텍스트. */
(function () {
  var shots = [].slice.call(document.querySelectorAll('.shot'));
  if (!shots.length) return;

  var idx = 0;
  var lastFocus = null;

  var box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '사진 크게 보기');
  box.innerHTML =
    '<button class="lb-btn lb-close" aria-label="닫기">✕</button>' +
    '<button class="lb-btn lb-prev" aria-label="이전 사진">‹</button>' +
    '<img alt="">' +
    '<button class="lb-btn lb-next" aria-label="다음 사진">›</button>' +
    '<div class="lb-cap"></div>';
  document.body.appendChild(box);

  var img = box.querySelector('img');
  var cap = box.querySelector('.lb-cap');

  function labelOf(el) {
    var l = el.querySelector('.shot-label');
    return l ? l.textContent.trim() : (el.querySelector('img') || {}).alt || '';
  }

  function show(i) {
    idx = (i + shots.length) % shots.length;
    var src = shots[idx].getAttribute('data-full') ||
              shots[idx].querySelector('img').getAttribute('src');
    img.src = src;
    img.alt = labelOf(shots[idx]);
    cap.textContent = labelOf(shots[idx]) + '  ·  ' + (idx + 1) + ' / ' + shots.length;
  }

  function open(i) {
    lastFocus = document.activeElement;
    show(i);
    box.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    box.querySelector('.lb-close').focus();
  }

  function close() {
    box.classList.remove('is-open');
    document.body.style.overflow = '';
    img.src = '';
    if (lastFocus) lastFocus.focus();
  }

  shots.forEach(function (s, i) {
    s.addEventListener('click', function () { open(i); });
  });

  box.querySelector('.lb-close').addEventListener('click', close);
  box.querySelector('.lb-prev').addEventListener('click', function () { show(idx - 1); });
  box.querySelector('.lb-next').addEventListener('click', function () { show(idx + 1); });

  // 사진 바깥(배경)을 누르면 닫는다.
  box.addEventListener('click', function (e) { if (e.target === box) close(); });

  document.addEventListener('keydown', function (e) {
    if (!box.classList.contains('is-open')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'ArrowRight') show(idx + 1);
    else if (e.key === 'Tab') {
      // 포커스가 라이트박스 밖으로 새지 않게 가둔다.
      var f = box.querySelectorAll('button');
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
})();
