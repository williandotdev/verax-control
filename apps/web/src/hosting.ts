import { securityHeaders } from './build-guards';

/** Configuração de um site no formato da API REST do Firebase Hosting (`VersionConfig`). */
export interface HostingConfig {
  headers: { glob: string; headers: Record<string, string> }[];
  rewrites: { glob: string; path: string }[];
}

/**
 * Dois anos de HTTPS obrigatório, inclusive nos subdomínios (o painel e a API de cada cliente). O Firebase Hosting
 * serve o próprio HSTS (1 ano, com subdomínios e preload) no lugar deste; ele fica para o caso de o painel mudar de
 * hospedagem.
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=63072000; includeSubDomains';

/**
 * Configuração do painel no Firebase Hosting. Os cabeçalhos de segurança vêm da mesma função usada no
 * `vite preview` dos testes e2e (`securityHeaders`): o que o e2e valida é o que vai para produção.
 *
 * Cache: tudo é revalidado a cada visita (o `index.html` chega também pela raiz e por qualquer rota da aplicação, e
 * um `index.html` velho apontaria para arquivos que a nova versão já não tem). Só `/assets/`, com hash no nome, tem
 * cache longo: a regra vem depois e prevalece. O workflow confere as duas coisas no site publicado.
 */
export function firebaseHostingConfig(apiUrl: string): HostingConfig {
  return {
    headers: [
      {
        glob: '**',
        headers: {
          ...securityHeaders(apiUrl),
          'Strict-Transport-Security': STRICT_TRANSPORT_SECURITY,
          'Cache-Control': 'no-cache',
        },
      },
      { glob: '/assets/**', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
    ],
    // Aplicação de página única: qualquer rota que não seja arquivo devolve o index.html.
    rewrites: [{ glob: '**', path: '/index.html' }],
  };
}
