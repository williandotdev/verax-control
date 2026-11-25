import type { FindingWebEvidence } from '@verax/shared';

/**
 * Os textos da evidência de um ataque web (`GET /v1/findings/:id/evidence`). Os códigos são abertos: um nó mais novo pode mandar
 * um que esta tela não conhece, e ele aparece como está, sem quebrar o resto.
 */

type Counter = keyof FindingWebEvidence['counters'];

/** As contagens, na ordem em que aparecem. */
export const EVIDENCE_COUNTERS: readonly { key: Counter; label: string }[] = [
  { key: 'requests', label: 'Requisições' },
  { key: 'blocked', label: 'Barradas pelo WAF' },
  { key: 'attempts', label: 'Tentativas de login' },
  { key: 'failures', label: 'Falhas de login' },
  { key: 'successes', label: 'Sucessos de login' },
  { key: 'probes', label: 'Sondas a caminhos sensíveis' },
  { key: 'answered', label: 'Respostas com conteúdo' },
  { key: 'toolRequests', label: 'De ferramenta de ataque' },
  { key: 'distinctPaths', label: 'Caminhos distintos' },
  { key: 'errors', label: 'Recusadas (400, 403, 404 e 405)' },
  { key: 'clients', label: 'Endereços' },
];

const NOTE_TEXTS: Readonly<Record<string, string>> = {
  counts_are_floor: 'As contagens são o mínimo: houve mais do que cabe na memória da detecção.',
  counts_are_estimated: 'As contagens são uma estimativa, feita a partir de uma amostra dos endereços.',
  late_object:
    'O arquivo chegou depois do fechamento da janela e foi avaliado sozinho: as contagens são o mínimo.',
  held_by_waf:
    'O WAF barrou 95% ou mais destas requisições, e o que passou não chega ao limite da regra. Por isso a severidade foi reduzida.',
  nat_like:
    'O endereço parece ser de uma rede com muita gente atrás (uma empresa, uma operadora): os limites valeram cinco vezes mais.',
  volume_only: 'A rota não distingue falha de sucesso pelo código da resposta: só o volume foi avaliado.',
  valid_account_possible:
    'O uso de uma conta válida é uma possibilidade, não uma constatação. Confira na sua aplicação.',
  client_not_direct: 'O endereço é de uma CDN, de um proxy ou de rede privada: nenhum visitante é apontado.',
  bytes_include_headers: 'Os bytes de cada amostra incluem os cabeçalhos da resposta.',
};

/** O que uma observação da evidência quer dizer; a que a tela não conhece aparece pelo código. */
export function evidenceNoteText(note: string): string {
  return Object.hasOwn(NOTE_TEXTS, note) ? (NOTE_TEXTS[note] ?? note) : `Observação do servidor: ${note}.`;
}

const CLIENT_CLASS_TEXTS: Readonly<Record<string, string>> = {
  direct: 'Conexão direta',
  customer_proxy: 'Proxy declarado por você',
  cloudflare: 'Cloudflare',
  cloudfront: 'CloudFront',
  private: 'Rede privada',
  unverified: 'Não verificado',
};

export const clientClassText = (code: string): string =>
  Object.hasOwn(CLIENT_CLASS_TEXTS, code) ? (CLIENT_CLASS_TEXTS[code] ?? code) : code;

const PROBE_FAMILY_TEXTS: Readonly<Record<string, string>> = {
  env: 'Arquivos .env',
  git: 'Repositório .git',
  cloud_keys: 'Chaves de nuvem e SSH',
  dump: 'Cópias de banco e backups',
  actuator: 'Spring Boot Actuator',
  phpinfo: 'phpinfo',
  wordpress: 'WordPress',
  db_admin: 'Administração de banco',
  web_admin: 'Painéis de administração',
  device: 'Roteadores e câmeras',
  php_rce: 'Execução remota em PHP',
  remote_access: 'VPN e acesso remoto',
  server_config: 'Configuração do servidor',
};

export const probeFamilyText = (code: string): string =>
  Object.hasOwn(PROBE_FAMILY_TEXTS, code) ? (PROBE_FAMILY_TEXTS[code] ?? code) : code;

/** As famílias de navegador, de biblioteca e de robô; as ferramentas de ataque aparecem pelo próprio nome. */
const UA_FAMILY_TEXTS: Readonly<Record<string, string>> = {
  googlebot: 'Googlebot (o que diz ser)',
  bingbot: 'Bingbot (o que diz ser)',
  python: 'Python',
  go: 'Go',
  java: 'Java',
  node: 'Node.js',
  php: 'PHP',
  okhttp: 'OkHttp',
  postman: 'Postman',
  other_bot: 'Outro robô',
  edge: 'Edge',
  firefox: 'Firefox',
  chrome: 'Chrome',
  safari: 'Safari',
  empty: 'Sem User-Agent',
  other: 'Outro',
};

export const uaFamilyText = (code: string): string =>
  Object.hasOwn(UA_FAMILY_TEXTS, code) ? (UA_FAMILY_TEXTS[code] ?? code) : code;

const ROUTE_KIND_TEXTS: Readonly<Record<string, string>> = {
  login: 'login',
  mfa: 'código de confirmação (MFA)',
  reset: 'redefinição de senha',
  signup: 'cadastro',
  api_token: 'emissão de token de API',
  ignore: 'não é login',
};
const ROUTE_SEMANTICS_TEXTS: Readonly<Record<string, string>> = {
  declared: 'declarada por você',
  observed: 'reconhecida pelas respostas',
  unknown: 'reconhecida pelo nome, sem saber o que é falha',
};

/** "login, declarada por você"; o que a tela não conhece fica de fora. */
export function routeText(kind: string | null, semantics: string | null): string | null {
  const parts = [
    kind === null ? undefined : ROUTE_KIND_TEXTS[kind],
    semantics === null ? undefined : ROUTE_SEMANTICS_TEXTS[semantics],
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? null : parts.join(', ');
}

/** O código de resposta como aparece: as faixas (`4xx`) e o que não teve resposta da aplicação (`-`). */
export function statusText(status: string): string {
  if (status === '-') return 'Sem resposta';
  return status === '4xx' ? 'Outros 4xx' : status;
}
