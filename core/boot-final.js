'use strict';

// Sustituye handlers inline bloqueados por CSP estricta.
(function bootFinal() {
  const searchWrap = document.getElementById('searchWrap');
  if (!searchWrap) return;
  if (searchWrap.dataset.cspSubmitBound === '1') return;

  searchWrap.addEventListener('submit', (ev) => {
    ev.preventDefault();
  });
  searchWrap.dataset.cspSubmitBound = '1';
})();
