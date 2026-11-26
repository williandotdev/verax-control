/**
 * O roteador nos testes de tela (E-13): as telas do painel entram por `import()`, e a primeira abertura de cada uma
 * compilava no meio do teste, passando da espera padrão com a suíte inteira rodando. Aqui elas são carregadas antes, e
 * `lazyPage` as desenha direto, como quando o roteador as importava. O `vite.config.ts` troca `@/routes/router` por
 * este arquivo só no Vitest; que cada tela vem no arquivo dela é conferido em `routes/router.test.tsx`.
 */
import { preloadPages } from '../routes/lazy-page';

export { createAppRouter, routes } from '../routes/router';

await preloadPages();
