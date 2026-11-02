import { securityHeaders } from './build-guards';

/** Configuração de um site no formato da API REST do Firebase Hosting (`VersionConfig`). */
export interface HostingConfig {
  headers: { glob: string; headers: Record<string, string> }[];
  rewrites: { glob: string; path: string }[];
}

/** Dois anos de HTTPS obrigatório, inclusive nos subdomínios (o painel e a API de cada cliente). */
export const STRICT_TRANSPORT_SECURITY = 'max-age=63072000; includeSubDomains';

/**
 * Configuração do painel no Firebase Hosting. Os cabeçalhos de segurança vêm da mesma função usada no
 * `vite preview` dos testes e2e (`securityHeaders`): o que o e2e valida é o que vai para produção.
 */
export function firebaseHostingConfig(apiUrl: string): HostingConfig {
  return {
    headers: [
      {
        glob: '**',
        headers: { ...securityHeaders(apiUrl), 'Strict-Transport-Security': STRICT_TRANSPORT_SECURITY },
      },
      // Arquivos com hash no nome nunca mudam: cache longo. O resto é revalidado a cada visita.
      { glob: '/assets/**', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
      { glob: '/index.html', headers: { 'Cache-Control': 'no-cache' } },
      { glob: '/*.js', headers: { 'Cache-Control': 'no-cache' } },
    ],
    // Aplicação de página única: qualquer rota que não seja arquivo devolve o index.html.
    rewrites: [{ glob: '**', path: '/index.html' }],
  };
}
