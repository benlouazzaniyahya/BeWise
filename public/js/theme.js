// Cartoon theme mouse effects: sparkle cursor trail, gentle 3D card tilt,
// confetti on button clicks and a soft card pop-in. Safe on touch + reduced-motion.
(function () {
  'use strict';

  if (!document.documentElement || typeof window.matchMedia !== 'function') return;
  var fine = window.matchMedia('(pointer: fine)').matches;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var fxHost = null;
  function host() {
    if (!fxHost) {
      fxHost = document.createElement('div');
      fxHost.id = 'toon-fx';
      fxHost.setAttribute('aria-hidden', 'true');
      document.body.appendChild(fxHost);
    }
    return fxHost;
  }

  // 1. Sparkle trail behind the mouse
  if (fine) {
    var glyphs = ['\u2726', '\u2727', '\u2605', '\u2606', '\u2022'];
    var colors = ['#ffd23f', '#ff5d8f', '#6d4aff', '#3ecf5b'];
    var last = 0;
    document.addEventListener('mousemove', function (e) {
      var now = Date.now();
      if (now - last < 45) return;
      last = now;
      var h = host();
      var s = document.createElement('span');
      s.className = 'fx-spark';
      s.textContent = glyphs[(now / 45) | 0 % glyphs.length];
      s.style.left = (e.clientX + (Math.random() * 14 - 7)) + 'px';
      s.style.top = (e.clientY + (Math.random() * 14 - 7)) + 'px';
      s.style.color = colors[Math.floor(Math.random() * colors.length)];
      h.appendChild(s);
      if (h.children.length > 40) h.firstChild.remove();
      setTimeout(function () { s.remove(); }, 750);
    });
  }

  // 2. Gentle 3D tilt for cards/stats (skips the game area)
  if (fine) {
    var tiltSel = '.card, .stat, .lesson-card, .lang-card, .hero-brand';
    document.addEventListener('mouseover', function (e) {
      var el = e.target && e.target.closest ? e.target.closest(tiltSel) : null;
      if (!el || el.__toonTilt) return;
      if (el.closest('.game-stage, [id^="game-preview"], #game-mount')) return;
      el.__toonTilt = true;
      function onMove(ev) {
        var rect = el.getBoundingClientRect();
        var cx = (ev.clientX - rect.left) / rect.width - 0.5;
        var cy = (ev.clientY - rect.top) / rect.height - 0.5;
        el.style.transform = 'perspective(720px) rotateY(' + (cx * 7).toFixed(2) + 'deg) rotateX(' + (-cy * 7).toFixed(2) + 'deg) translateY(-2px)';
      }
      function onLeave() {
        el.style.transform = '';
        el.removeEventListener('mousemove', onMove);
        el.removeEventListener('mouseleave', onLeave);
        delete el.__toonTilt;
      }
      el.addEventListener('mousemove', onMove);
      el.addEventListener('mouseleave', onLeave);
    });
  }

  // 3. Confetti burst when clicking a button
  if (fine) {
    var cc = ['#ffd23f', '#ff5d8f', '#6d4aff', '#3ecf5b', '#00b8a9', '#ff8a3d'];
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.btn') : null;
      if (!btn || btn.disabled) return;
      var h = host();
      var x = e.clientX, y = e.clientY;
      for (var i = 0; i < 12; i++) {
        var c = document.createElement('span');
        c.className = 'fx-confetti';
        c.style.left = x + 'px';
        c.style.top = y + 'px';
        c.style.background = cc[i % cc.length];
        c.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
        c.style.setProperty('--dy', (-(50 + Math.random() * 90)) + 'px');
        c.style.setProperty('--rot', (Math.random() * 360 - 180) + 'deg');
        h.appendChild(c);
        setTimeout(function () { c.remove(); }, 900);
      }
    });
  }

  // 4. Soft pop-in when cards scroll into view
  var targets = document.querySelectorAll('.card, .stat, .lesson-card, .lang-card');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('toon-in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.08 });
    for (var i = 0; i < targets.length; i++) io.observe(targets[i]);
  } else {
    for (var j = 0; j < targets.length; j++) targets[j].classList.add('toon-in');
  }
})();