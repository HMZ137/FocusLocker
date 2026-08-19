/* FocusLocker 官网交互 */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 星点背景 ---------- */
  var starsWrap = document.getElementById('stars');
  if (starsWrap && !reducedMotion) {
    var COUNT = 70;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < COUNT; i++) {
      var s = document.createElement('span');
      s.className = 'star';
      var size = (Math.random() * 1.6 + 1).toFixed(1);
      s.style.width = size + 'px';
      s.style.height = size + 'px';
      s.style.left = (Math.random() * 100).toFixed(2) + '%';
      s.style.top = (Math.random() * 100).toFixed(2) + '%';
      s.style.animationDuration = (Math.random() * 4 + 2.5).toFixed(1) + 's';
      s.style.animationDelay = (Math.random() * 4).toFixed(1) + 's';
      frag.appendChild(s);
    }
    starsWrap.appendChild(frag);
  }

  /* ---------- 滚动进度条 ---------- */
  var progressBar = document.getElementById('scrollProgress');
  function updateProgress() {
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var p = max > 0 ? (window.scrollY / max) * 100 : 0;
    progressBar.style.width = p + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress);
  updateProgress();

  /* ---------- 顶部导航：滚动状态 ---------- */
  var header = document.getElementById('siteHeader');
  function onScroll() {
    if (window.scrollY > 24) header.classList.add('scrolled');
    else header.classList.remove('scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- 移动端菜单 ---------- */
  var navToggle = document.getElementById('navToggle');
  var mobileMenu = document.getElementById('mobileMenu');
  navToggle.addEventListener('click', function () {
    var open = mobileMenu.classList.toggle('show');
    navToggle.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  mobileMenu.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') {
      mobileMenu.classList.remove('show');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    }
  });

  /* ---------- 锚点滚动偏移（固定导航补偿） ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var id = this.getAttribute('href');
      if (id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      var y = target.getBoundingClientRect().top + window.pageYOffset - 72;
      window.scrollTo({ top: y, behavior: reducedMotion ? 'auto' : 'smooth' });
    });
  });

  /* ---------- 滚动显现 ---------- */
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('visible'); });
  }

  /* ---------- 界面预览 Tab 切换 ---------- */
  var tabs = document.querySelectorAll('.tabbar .tab');
  var panels = document.querySelectorAll('.showcase-panel');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      var panelId = tab.getAttribute('data-panel');
      panels.forEach(function (p) {
        p.classList.toggle('active', p.id === panelId);
      });
    });
  });

  /* ---------- FAQ 手风琴 ---------- */
  var faqQs = document.querySelectorAll('.faq-q');
  faqQs.forEach(function (q) {
    q.addEventListener('click', function () {
      var item = q.closest('.faq-item');
      var isOpen = item.classList.contains('open');
      // 关闭其它项
      faqQs.forEach(function (other) {
        var oi = other.closest('.faq-item');
        oi.classList.remove('open');
        oi.querySelector('.faq-a').style.maxHeight = '0px';
        other.setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        item.classList.add('open');
        var answer = item.querySelector('.faq-a');
        answer.style.maxHeight = answer.scrollHeight + 'px';
        q.setAttribute('aria-expanded', 'true');
      }
    });
  });

  /* ---------- Hero 演示：站点标签切换 ---------- */
  var sitebar = document.getElementById('mockSitebar');
  if (sitebar) {
    sitebar.addEventListener('click', function (e) {
      var chip = e.target.closest('.site-chip');
      if (!chip) return;
      sitebar.querySelectorAll('.site-chip').forEach(function (c) {
        c.classList.toggle('active', c === chip);
      });
    });
  }

  /* ---------- Hero 演示：倒计时 ---------- */
  var clock = document.getElementById('mockClock');
  var progress = document.getElementById('mockProgress');
  var totalSeconds = 2 * 3600 + 47 * 60 + 16;
  var remaining = totalSeconds;
  var startedAt = Date.now();

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function render() {
    var h = Math.floor(remaining / 3600);
    var m = Math.floor((remaining % 3600) / 60);
    var s = remaining % 60;
    clock.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
    progress.style.width = ((remaining / totalSeconds) * 62).toFixed(1) + '%';
  }
  render();
  setInterval(function () {
    var elapsed = Math.floor((Date.now() - startedAt) / 1000);
    remaining = Math.max(0, totalSeconds - elapsed);
    render();
  }, 1000);
})();
