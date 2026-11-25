import {
  isAwsSourcePermissionDetail,
  WEB_LOGS_ERROR_CODES,
  type WebLogsErrorCode,
  type WebRouteKind,
  type WebRouteMethod,
  type WebSourceMode,
  type WebTrustedKind,
} from '@verax/shared';
import type { Severity } from '@/design/severity';
import { awsPermissionDetailText } from '@/features/admin/aws-onboarding-labels';
import { awsConnectionErrorHint } from '@/features/admin/labels';
import { ApiRequestError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';

/**
 * Os textos dos ataques web pelos logs do ALB. A API manda só códigos, e o catálogo do motor pode crescer num nó mais novo:
 * todo código desconhecido tem um texto genérico, nunca um erro. Nada do que o atacante escolhe entra num texto daqui.
 */

// --- Regras ---

interface RuleText {
  /** O título do achado (o mesmo da API). */
  title: string;
  /** O que a regra viu, para quem nunca leu um log. */
  what: string;
}

export const WEB_RULE_TEXTS: Readonly<Record<string, RuleText>> = {
  '990400': {
    title: 'Varredura oportunista contra o balanceador (resumo do dia)',
    what: 'O ruído do dia: robôs e varreduras que passam por qualquer site da internet, juntos num alerta só.',
  },
  '990401': {
    title: 'Ferramenta de ataque identificada pelo User-Agent',
    what: 'Um mesmo endereço fez requisições se identificando como uma ferramenta de ataque.',
  },
  '990402': {
    title: 'Sondagem de caminhos sensíveis por um mesmo endereço',
    what: 'Um mesmo endereço procurou arquivos e painéis que não deveriam estar expostos (senhas, cópias de banco, administração).',
  },
  '990403': {
    title: 'Caminho sensível respondido com conteúdo',
    what: 'A aplicação respondeu com conteúdo a um caminho que não deveria existir na internet. Confira agora o que foi entregue.',
  },
  '990404': {
    title: 'Enumeração de rotas por um mesmo endereço',
    what: 'Um mesmo endereço tentou muitos caminhos diferentes, e a maioria foi recusada: alguém mapeando o que existe na aplicação.',
  },
  '990405': {
    title: 'Força bruta numa rota de login por um mesmo endereço',
    what: 'Um mesmo endereço tentou entrar muitas vezes na mesma rota de login.',
  },
  '990406': {
    title: 'Falhas de login seguidas de sucesso (possível acesso indevido)',
    what: 'Depois de muitas falhas, o mesmo endereço conseguiu entrar na mesma rota. Confira de quem é o acesso.',
  },
  '990407': {
    title: 'Força bruta distribuída numa rota de login',
    what: 'Muitos endereços, cada um com poucas tentativas, atacaram a mesma rota de login ao mesmo tempo.',
  },
};

export function webRuleTitle(ruleId: string): string {
  return Object.hasOwn(WEB_RULE_TEXTS, ruleId)
    ? (WEB_RULE_TEXTS[ruleId]?.title ?? ruleId)
    : `Regra ${ruleId}`;
}

/** O que a regra viu; null na regra que esta versão da tela não conhece. */
export function webRuleText(ruleId: string): string | null {
  return Object.hasOwn(WEB_RULE_TEXTS, ruleId) ? (WEB_RULE_TEXTS[ruleId]?.what ?? null) : null;
}

/** A severidade de um nível de regra, na escala das outras (12 crítica, 10 alta, 7 média, abaixo baixa). */
export function severityOfLevel(level: number): Exclude<Severity, 'ok'> {
  if (level >= 12) return 'critical';
  if (level >= 10) return 'high';
  return level >= 7 ? 'medium' : 'low';
}

/** As regras que uma fonte confiável nunca cala, e as que ela cala. */
export const NEVER_SILENCED_RULES = ['990403', '990406', '990407'] as const;
export const SILENCED_RULES = ['990401', '990402', '990404', '990405'] as const;

// --- Modo ---

export const WEB_MODE_LABELS: Readonly<Record<WebSourceMode, string>> = {
  observe: 'Observando',
  alert: 'Alertando',
};

// --- Motivos da estimativa ---

const ESTIMATE_ERROR_TEXTS: Readonly<Record<string, string>> = {
  account_not_connected:
    'a conta não estava conectada na hora da leitura. Confira a conexão da conta e peça de novo',
  source_not_available:
    'o balanceador não está mais disponível para leitura (o log foi desligado, ou ele sumiu da conta). Rode a descoberta de novo',
  invalid_details:
    'o que a descoberta guardou deste balanceador não basta para lê-lo. Rode a descoberta de novo e peça outra vez',
  web_prefix_unsupported:
    'o prefixo do log no bucket tem um caractere que a leitura não aceita. Tire o prefixo na configuração do log do balanceador, rode a descoberta de novo e peça outra vez',
  throttled: 'a AWS limitou as chamadas. Peça de novo daqui a alguns minutos',
  NetworkError: 'a conexão com o S3 caiu no meio da leitura. Peça de novo daqui a alguns minutos',
  TimeoutError: 'a AWS não respondeu a tempo. Peça de novo daqui a alguns minutos',
};

/** Por que a estimativa falhou e o que fazer, numa frase sem o ponto final. */
export function estimateErrorText(code: string | null): string {
  if (code === null) return 'o motivo não foi informado. Peça de novo daqui a alguns minutos';
  if (Object.hasOwn(ESTIMATE_ERROR_TEXTS, code)) return ESTIMATE_ERROR_TEXTS[code] ?? code;
  // A permissão que falta no S3, com o mesmo texto das outras fontes.
  if (isAwsSourcePermissionDetail(code)) {
    return `${awsPermissionDetailText(code)}. Corrija a permissão, rode a descoberta de novo e peça outra vez`;
  }
  // A entrada no papel de leitura.
  const connection = awsConnectionErrorHint(code);
  if (connection !== null) {
    const text = connection.trimEnd();
    return text.endsWith('.') ? text.slice(0, -1) : text;
  }
  return `a AWS respondeu ${code}. Peça de novo daqui a alguns minutos`;
}

// --- Recusas da API ---

export const WEB_LOGS_ERROR_TEXTS: Readonly<Record<WebLogsErrorCode, string>> = {
  SOURCE_NOT_AUTHORIZED: 'Este balanceador não está mais autorizado. Atualize a tela.',
  SOURCE_NOT_AVAILABLE: 'Este balanceador não está mais disponível para leitura. Rode a descoberta de novo.',
  SOURCE_PERMISSION_MISSING:
    'O Verax ainda não tem permissão para ler este balanceador. Resolva em "Precisam de permissão adicional".',
  ACCOUNT_NOT_CONNECTED:
    'A conta não está conectada agora. Conecte a conta (ou espere a verificação terminar) e peça de novo.',
  WEB_OBSERVATION_PENDING:
    'A observação deste balanceador ainda não terminou: ele só passa a alertar depois das 72 horas.',
  WEB_TRUSTED_LIMIT_REACHED:
    'O limite é de 200 fontes confiáveis por cliente, contando as vencidas. Tire uma para incluir outra.',
  WEB_TRUSTED_DUPLICATE: 'Esta faixa já é uma fonte confiável ali. Renove a que existe.',
  WEB_TRUSTED_EXPIRY_INVALID: 'A validade precisa ser no futuro, em até 365 dias.',
  WEB_ROUTE_LIMIT_REACHED: 'O limite é de 50 rotas declaradas por balanceador. Tire uma para declarar outra.',
  WEB_ROUTE_DUPLICATE:
    'Esta rota já está declarada, com o mesmo host, método e caminho. Altere a que existe.',
  WEB_ESTIMATE_RATE_LIMITED:
    'A estimativa deste balanceador acabou de ser pedida. Só é possível pedir outra 5 minutos depois.',
};

function isWebLogsCode(code: string): code is WebLogsErrorCode {
  return (WEB_LOGS_ERROR_CODES as readonly string[]).includes(code);
}

/** O que dizer de um pedido recusado. O 404 no meio do uso: o nó desligou a funcionalidade, ou o item saiu. */
export function webLogsErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code !== undefined && isWebLogsCode(error.code)) return WEB_LOGS_ERROR_TEXTS[error.code];
    if (error.status === 404) return 'Isto não existe mais aqui. Atualize a tela e confira.';
    if (error.status === 400) {
      const [issue] = error.issues ?? [];
      return issue === undefined || issue.message === '' ? error.message : `Dado recusado: ${issue.message}.`;
    }
  }
  return errorMessage(error);
}

// --- Rotas declaradas ---

export const WEB_ROUTE_KIND_TEXTS: Readonly<Record<WebRouteKind, { label: string; hint: string }>> = {
  login: { label: 'Login', hint: 'Onde as pessoas entram com a senha.' },
  mfa: { label: 'Código de confirmação (MFA)', hint: 'Onde o código de segunda etapa é conferido.' },
  reset: { label: 'Redefinição de senha', hint: 'Onde a senha é trocada ou recuperada.' },
  signup: { label: 'Cadastro', hint: 'Onde uma conta nova é criada.' },
  api_token: { label: 'Emissão de token de API', hint: 'Onde uma aplicação troca credencial por token.' },
  ignore: {
    label: 'Não é login',
    hint: 'Só diz que a rota não é de login. Não cala sondagem, enumeração nem caminho sensível respondido.',
  },
};

export const WEB_ROUTE_METHOD_LABELS: Readonly<Record<WebRouteMethod, string>> = {
  ANY: 'Qualquer método',
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
};

// --- Fontes confiáveis ---

export const WEB_TRUSTED_KIND_TEXTS: Readonly<Record<WebTrustedKind, { label: string; hint: string }>> = {
  monitor: { label: 'Monitoramento', hint: 'O serviço que confere se o site está no ar.' },
  office: { label: 'Escritório', hint: 'A saída de internet da sua empresa.' },
  partner: { label: 'Parceiro', hint: 'Um integrador que chama a sua aplicação.' },
  pentest: { label: 'Teste de invasão', hint: 'A equipe contratada para atacar, enquanto durar o teste.' },
  proxy: {
    label: 'Proxy ou CDN seu',
    hint: 'Não cala nada: diz que atrás deste endereço há muitos visitantes, e as regras por endereço deixam de valer para ele.',
  },
};

// --- Notas do motor ---

const ENGINE_NOTE_TEXTS: Readonly<Record<string, { title: string; text: string }>> = {
  behind_proxy: {
    title: 'A maior parte das requisições chega por uma CDN ou um proxy.',
    text: 'O log do balanceador só mostra o endereço da CDN, e não o de quem visita. Por isso as regras por endereço ficam desligadas para essas conexões; a força bruta distribuída e as contagens continuam. Para enxergar o visitante, use os eventos do WAF ou da própria CDN.',
  },
  proxy_ranges_stale: {
    title: 'A lista de endereços das CDNs está velha.',
    text: 'Um endereço novo de CDN pode ser tratado como um visitante só. A lista é atualizada junto com a versão do Verax.',
  },
  proxy_ranges_unavailable: {
    title: 'A lista de endereços das CDNs não pôde ser lida.',
    text: 'Sem ela, nenhum endereço é apontado como atacante. O problema é do servidor do Verax: fale com a Verax.',
  },
  trusted_rejected: {
    title: 'Uma fonte confiável não está valendo.',
    text: 'A faixa ou a validade dela está fora do que a detecção aceita. Confira as fontes confiáveis deste balanceador.',
  },
  truncated: {
    title: 'As contagens são o mínimo.',
    text: 'Houve mais endereços ou caminhos do que cabe na memória da detecção. Os ataques maiores continuam aparecendo.',
  },
};

export function engineNoteText(note: string): { title: string; text: string | null } {
  return Object.hasOwn(ENGINE_NOTE_TEXTS, note)
    ? (ENGINE_NOTE_TEXTS[note] ?? { title: note, text: null })
    : { title: `Aviso da leitura: ${note}.`, text: null };
}

// --- O que a detecção não vê ---

/** Os limites, em português simples, para ninguém tomar silêncio por segurança. */
export const DETECTION_LIMITS: readonly { title: string; text: string }[] = [
  {
    title: 'CDN ou proxy na frente',
    text: 'Com Cloudflare, CloudFront ou um proxy seu na frente, o log só mostra o endereço deles. As regras por endereço não valem para essas conexões.',
  },
  {
    title: 'A AWS entrega o log pelo melhor esforço',
    text: 'Alguma requisição pode faltar ou chegar horas depois. O log serve para entender ataques, e não como contabilidade de todas as requisições.',
  },
  {
    title: 'Não é na hora',
    text: 'A AWS grava um arquivo a cada 5 minutos. Um ataque aparece em geral em até 15 minutos.',
  },
  {
    title: 'O log não traz senha, usuário nem o corpo da requisição',
    text: 'Não dá para saber qual conta foi atacada. "Sucesso" e "falha" são o código da resposta: numa rota que responde sempre 200, só o volume é avaliado.',
  },
  {
    title: 'Ataque lento ou espalhado',
    text: 'Poucas tentativas por hora, ou endereços que mudam o tempo todo, podem ficar abaixo dos limites das regras.',
  },
  {
    title: 'Só balanceadores de aplicação (ALB) com log no S3',
    text: 'NLB, GWLB e os balanceadores clássicos ficam de fora. O log que a AWS entrega pelo CloudWatch também.',
  },
];

// --- O que o cliente precisa saber do dado ---

export const WEB_DATA_TEXT =
  'O Verax analisa todas as linhas do log e não guarda nenhuma: fica só a evidência mascarada de um ataque, com a indicação do arquivo no seu S3. O original segue no seu bucket, pela sua retenção; recomendamos ao menos 180 dias. Os endereços IP de quem visita a sua aplicação são tratados nessa análise.';
