'use strict';

// Bootstrap CSP-safe: replace any previous inline submit prevention.
(function bootProduction() {
  const searchWrap = document.getElementById('searchWrap');
  if (!searchWrap) return;
  if (searchWrap.dataset.cspSubmitBound === '1') return;

  searchWrap.addEventListener('submit', (ev) => {
    ev.preventDefault();
  });
  searchWrap.dataset.cspSubmitBound = '1';
})();
