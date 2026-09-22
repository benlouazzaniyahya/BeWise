// small shared helpers for the demo UI
(function () {
  'use strict';

  document.addEventListener('click', function (e) {
    const target = e.target.closest('[data-confirm]');
    if (target && !window.confirm(target.getAttribute('data-confirm'))) {
      e.preventDefault();
    }
  });
})();