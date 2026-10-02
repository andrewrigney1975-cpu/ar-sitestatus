// Runs synchronously in <head> so an explicit light/dark choice applies before first paint.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('sitestatus.settings.v1') || '{}');
    if (s.theme === 'light' || s.theme === 'dark') document.documentElement.dataset.theme = s.theme;
  } catch (e) { /* storage unavailable: follow the system theme */ }
})();
