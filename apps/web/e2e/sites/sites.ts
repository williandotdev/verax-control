/** Porta do servidor que faz o papel do Firebase Hosting no e2e do build único. */
export const PORT = 4180;

/** O `VITE_API_URL` do build único. */
export const API_TEMPLATE = 'https://api-{tenant}.veraxsistemas.com.br';

/** Clientes fictícios, um site cada. */
export const TENANTS = ['cliente-demo-a', 'cliente-demo-b'] as const;

export const panelHost = (tenant: string): string => `${tenant}.control.veraxsistemas.com.br`;

/** Endereço que imita o de um cliente, mas é outro domínio: o painel não pode derivar API dele. */
export const LOOKALIKE_HOST = 'cliente-demo-a.control.veraxsistemas.com.br.example';

/**
 * O navegador resolve os domínios de produção do teste para a própria máquina, sem DNS nem arquivo de hosts. A API
 * de cada cliente não entra aqui: o teste a intercepta antes de qualquer rede.
 */
export const HOST_RESOLVER_RULES = [...TENANTS.map(panelHost), LOOKALIKE_HOST]
  .map((host) => `MAP ${host} 127.0.0.1`)
  .join(', ');
