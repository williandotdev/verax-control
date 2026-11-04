// Aplica o tema antes da primeira pintura, sem piscar. Arquivo externo (e não script inline) porque a CSP do console
// só permite scripts da própria origem (apps/control-plane/src/admin/console-assets.ts). Molde do painel.
(function () {
  try {
    var stored = window.localStorage.getItem('verax.console.theme');
    var theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    document.documentElement.dataset.theme = theme;
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
