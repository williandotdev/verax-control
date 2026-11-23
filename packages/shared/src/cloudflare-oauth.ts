import { z } from 'zod';
import { tenantSlugSchema } from './cell-protocol.js';
import { type CloudflareBlockingError, cloudflareAccountIdSchema, isDomainName } from './cloud-accounts.js';
import type { NodePlatform } from './cloud-credentials.js';

/**
 * Conexão da conta do Cloudflare por OAuth ("Conectar com Cloudflare"): o cliente autoriza a leitura na tela do próprio
 * Cloudflare, sem criar nem colar token. Fluxo de código de autorização com PKCE (S256):
 *
 * 1. `POST /v1/cloudflare-oauth/start`: a API do nó gera o `state` e o verificador, guarda a tentativa presa à sessão de
 *    quem clicou e devolve a URL de autorização;
 * 2. o Cloudflare devolve `code`, `state` e `iss` ao endereço fixo da Verax (`CLOUDFLARE_OAUTH_CALLBACK_PATH`), que só
 *    os repassa ao painel do cliente, no fragmento da URL (`CLOUDFLARE_OAUTH_PANEL_PATH`), sem guardar nada;
 * 3. `POST /v1/cloudflare-oauth/complete`: a API confere a tentativa e guarda o código cifrado para o worker, que o
 *    troca pelos tokens. Nenhum token passa pela API nem pelo plano de controle;
 * 4. o painel acompanha a tentativa e, com mais de uma conta autorizada, o cliente escolhe quais monitorar.
 *
 * Só existe no nó dedicado gerenciado pela Verax com a configuração ligada (`cloudflareConnectMode`). Desligada, as
 * rotas respondem 404 e o token colado continua como sempre. O contrato por si não liga nada: o nó só anuncia a
 * capacidade `cloudflare_oauth` quando a usa.
 *
 * Os nomes dos escopos, a renovação sem segredo e os prazos dependem do app registrado no Cloudflare: nada disso é
 * fixo aqui (vem da configuração ou da resposta do Cloudflare).
 */

/** O emissor do documento de descoberta do Cloudflare; o `iss` do retorno é comparado por igualdade. */
export const CLOUDFLARE_OAUTH_ISSUER = 'https://dash.cloudflare.com' as const;
export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth' as const;
export const CLOUDFLARE_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token' as const;
export const CLOUDFLARE_OAUTH_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke' as const;

/** O retorno fixo, no host público do plano de controle. */
export const CLOUDFLARE_OAUTH_CALLBACK_PATH = '/v1/public/cloudflare/callback' as const;
/** A página do painel do cliente que recebe o retorno no fragmento. */
export const CLOUDFLARE_OAUTH_PANEL_PATH = '/conexao-cloudflare' as const;

/** Quanto vale uma tentativa, do clique ao retorno do Cloudflare. */
export const CLOUDFLARE_OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
/** As tentativas terminadas somem depois deste prazo, contado da criação. */
export const CLOUDFLARE_OAUTH_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Como a conta do Cloudflare é conectada neste nó: por OAuth ou pelo token colado. Um exclui o outro para conexões
 * novas (decisão de 23/11/2026): com o OAuth ligado no nó gerenciado, um token novo é recusado
 * (`CLOUDFLARE_OAUTH_ONLY_CODE`), e as contas que já coletam com token seguem coletando. Na VM própria do cliente, só
 * o token colado.
 */
export const CLOUDFLARE_CONNECT_MODES = ['oauth', 'token'] as const;
export type CloudflareConnectMode = (typeof CLOUDFLARE_CONNECT_MODES)[number];

/** Recusa do token colado no nó em que o Cloudflare é conectado por OAuth (409). */
export const CLOUDFLARE_OAUTH_ONLY_CODE = 'CLOUDFLARE_OAUTH_ONLY';

/** O nó conecta por OAuth só quando é o gerenciado e recebeu a configuração; em qualquer outro caso, pelo token. */
export function cloudflareConnectMode(node: {
  platform: NodePlatform;
  oauth: CloudflareOauthConfig | null;
}): CloudflareConnectMode {
  return node.platform === 'gcp' && node.oauth !== null ? 'oauth' : 'token';
}

/** Resposta de `GET /v1/cloudflare-oauth/options`. Com o OAuth desligado (ou num nó anterior), 404: o modo é o token. */
export const cloudflareConnectOptionsSchema = z.strictObject({ mode: z.enum(CLOUDFLARE_CONNECT_MODES) });
export type CloudflareConnectOptions = z.infer<typeof cloudflareConnectOptionsSchema>;

/** Os escopos de protocolo que pedem a renovação; os dois constam da descoberta do Cloudflare. */
export const CLOUDFLARE_OAUTH_OFFLINE_SCOPES = ['offline_access', 'offline'] as const;
export const CLOUDFLARE_OAUTH_MAX_SCOPES = 16;
export const CLOUDFLARE_OAUTH_MAX_SCOPE_LENGTH = 64;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** O escopo pede a renovação (`offline_access` ou `offline`)? */
export function isCloudflareOfflineScope(scope: string): boolean {
  return (CLOUDFLARE_OAUTH_OFFLINE_SCOPES as readonly string[]).includes(scope);
}

/**
 * O escopo é só de leitura? Lista do que pode, e não do que não pode: `<recurso>.read` (um recurso e o `.read` no fim,
 * sem outra parte) ou o da renovação. Um nome que não siga isso é recusado até o código passar a conhecê-lo, e um
 * escopo de escrita com nome novo nunca entra por engano.
 */
export function isCloudflareReadOnlyScope(scope: string): boolean {
  if (scope.length > CLOUDFLARE_OAUTH_MAX_SCOPE_LENGTH || !SCOPE_PATTERN.test(scope)) return false;
  if (isCloudflareOfflineScope(scope)) return true;
  const parts = scope.split('.');
  return parts.length === 2 && parts[0] !== '' && parts[1] === 'read';
}

export const cloudflareOauthScopeSchema = z
  .string()
  .refine(isCloudflareReadOnlyScope, { error: 'escopo inválido: só leitura' });

/** Os escopos pedidos: sem repetição, ao menos um de leitura e o da renovação (sem ele a coleta morreria em horas). */
export const cloudflareOauthScopesSchema = z
  .array(cloudflareOauthScopeSchema)
  .max(CLOUDFLARE_OAUTH_MAX_SCOPES)
  .refine((scopes) => new Set(scopes).size === scopes.length, { error: 'escopo repetido' })
  .refine((scopes) => scopes.some((scope) => !isCloudflareOfflineScope(scope)), {
    error: 'falta um escopo de leitura',
  })
  .refine((scopes) => scopes.some(isCloudflareOfflineScope), { error: 'falta o escopo da renovação' });

/** O que falta e o que sobra nos escopos concedidos. */
export interface CloudflareScopeDifference {
  missing: string[];
  unexpected: string[];
}

/**
 * Compara o `scope` da resposta (separado por espaço) com o pedido. Sobra (um escopo que não foi pedido, de leitura ou
 * não) recusa a conexão, como a falta. Os da renovação não contam: a resposta pode não repeti-los, e o que prova a
 * renovação é ela vir na resposta.
 */
export function compareCloudflareScopes(
  requested: readonly string[],
  granted: string,
): CloudflareScopeDifference {
  const received = new Set(granted.split(' ').filter((scope) => scope !== ''));
  const wanted = new Set(requested);
  return {
    missing: [...wanted].filter((scope) => !isCloudflareOfflineScope(scope) && !received.has(scope)),
    unexpected: [...received].filter((scope) => !isCloudflareOfflineScope(scope) && !wanted.has(scope)),
  };
}

/** O identificador do app no Cloudflare: não é segredo (vai na URL de autorização). */
export const cloudflareOauthClientIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, { error: 'client_id inválido' });

/**
 * O endereço de retorno registrado no app: https, o caminho exato do repasse e nada mais (sem porta, usuário, query nem
 * fragmento). É comparado por igualdade com o registrado, então só a forma canônica passa.
 */
export function isCloudflareOauthRedirectUri(value: string): boolean {
  if (value.length > 256) return false;
  if (!value.startsWith('https://') || !value.endsWith(CLOUDFLARE_OAUTH_CALLBACK_PATH)) return false;
  const host = value.slice('https://'.length, -CLOUDFLARE_OAUTH_CALLBACK_PATH.length);
  return isDomainName(host);
}

export const cloudflareOauthRedirectUriSchema = z
  .string()
  .refine(isCloudflareOauthRedirectUri, { error: 'endereço de retorno inválido' });

/**
 * A configuração do app, sem segredo. Chega ao nó pela sincronização (`node-sync.ts`, seção `cloudflareOauth`) e o nó a
 * valida de novo: um plano de controle comprometido não faz o nó pedir escopo de escrita.
 */
export const cloudflareOauthConfigSchema = z.strictObject({
  clientId: cloudflareOauthClientIdSchema,
  redirectUri: cloudflareOauthRedirectUriSchema,
  scopes: cloudflareOauthScopesSchema,
});
export type CloudflareOauthConfig = z.infer<typeof cloudflareOauthConfigSchema>;

/** 32 bytes em base64url, sem preenchimento: a parte aleatória do `state`. */
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** O maior `state`: o subdomínio (16), o ponto e a parte aleatória (43). */
export const CLOUDFLARE_OAUTH_STATE_MAX_LENGTH = 60;

/**
 * As duas partes do `state`, `<subdomínio>.<aleatório>`, ou null fora do formato. O subdomínio só diz ao repasse a qual
 * painel da Verax devolver o navegador: quem decide se a tentativa vale é a API do nó, pelo `state` inteiro e a sessão.
 */
export function parseCloudflareOauthState(state: string): { slug: string; nonce: string } | null {
  if (state.length > CLOUDFLARE_OAUTH_STATE_MAX_LENGTH) return null;
  const parts = state.split('.');
  const [slug, nonce] = parts;
  if (parts.length !== 2 || slug === undefined || nonce === undefined) return null;
  if (!tenantSlugSchema.safeParse(slug).success || !OPAQUE_PATTERN.test(nonce)) return null;
  return { slug, nonce };
}

export const cloudflareOauthStateSchema = z
  .string()
  .refine((value) => parseCloudflareOauthState(value) !== null, { error: 'state inválido' });

/** O código de autorização: opaco, de alfabeto e tamanho limitados. */
export const CLOUDFLARE_OAUTH_CODE_MAX_LENGTH = 1024;
export const cloudflareOauthCodeSchema = z
  .string()
  .min(8)
  .max(CLOUDFLARE_OAUTH_CODE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~+/=-]+$/, { error: 'código inválido' });

/** O verificador do PKCE (RFC 7636): 43 a 128 caracteres do alfabeto sem reserva. */
export const cloudflareOauthVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/**
 * O que o repasse entrega quando o Cloudflare devolve `error` em vez de `code`: o código do OAuth, se conhecido, ou
 * `other`. A descrição do erro nunca é repassada.
 */
export const CLOUDFLARE_OAUTH_CALLBACK_ERRORS = [
  'access_denied',
  'invalid_request',
  'invalid_scope',
  'unauthorized_client',
  'unsupported_response_type',
  'server_error',
  'temporarily_unavailable',
  'other',
] as const;
export type CloudflareOauthCallbackError = (typeof CLOUDFLARE_OAUTH_CALLBACK_ERRORS)[number];

/** O erro do Cloudflare na lista fechada; desconhecido, `other`. */
export function cloudflareOauthCallbackError(value: string): CloudflareOauthCallbackError {
  return CLOUDFLARE_OAUTH_CALLBACK_ERRORS.find((known) => known === value) ?? 'other';
}

/** Corpo de `POST /v1/cloudflare-oauth/start`. Com `cloudAccountId`, reconecta ou migra uma conta já cadastrada. */
export const cloudflareOauthStartSchema = z.strictObject({ cloudAccountId: z.uuid().optional() });
export type CloudflareOauthStart = z.infer<typeof cloudflareOauthStartSchema>;

/** A URL para onde o painel navega: só a de autorização do Cloudflare. */
export function isCloudflareAuthorizeUrl(value: string): boolean {
  return value.length <= 2048 && value.startsWith(`${CLOUDFLARE_OAUTH_AUTHORIZE_URL}?`);
}

export const cloudflareOauthStartedSchema = z.strictObject({
  attemptId: z.uuid(),
  authorizeUrl: z.string().refine(isCloudflareAuthorizeUrl, { error: 'endereço de autorização inválido' }),
  expiresAt: z.iso.datetime(),
});
export type CloudflareOauthStarted = z.infer<typeof cloudflareOauthStartedSchema>;

/**
 * Corpo de `POST /v1/cloudflare-oauth/complete`: o que o painel leu do fragmento. O `iss` é obrigatório junto do código
 * e conferido por igualdade na API (aqui só o tamanho, para a recusa ser a mesma das outras). Com `error`, o cliente
 * recusou ou o Cloudflare não autorizou: a tentativa termina.
 */
export const cloudflareOauthCompleteSchema = z.union([
  z.strictObject({
    state: cloudflareOauthStateSchema,
    code: cloudflareOauthCodeSchema,
    iss: z.string().min(1).max(256),
  }),
  z.strictObject({
    state: cloudflareOauthStateSchema,
    error: z.enum(CLOUDFLARE_OAUTH_CALLBACK_ERRORS),
  }),
]);
export type CloudflareOauthComplete = z.infer<typeof cloudflareOauthCompleteSchema>;

/** Resposta do `complete`: o painel passa a acompanhar a tentativa. */
export const cloudflareOauthCompletedSchema = z.strictObject({ attemptId: z.uuid() });
export type CloudflareOauthCompleted = z.infer<typeof cloudflareOauthCompletedSchema>;

/**
 * A recusa do `complete` é sempre a mesma (400): outra sessão, outro usuário, outro cliente, vencida, repetida ou `iss`
 * diferente. O motivo só vai à trilha, por código.
 */
export const CLOUDFLARE_OAUTH_REFUSED_CODE = 'CLOUDFLARE_OAUTH_REFUSED';

/**
 * A tentativa (`CloudflareConnectAttempt` do banco do nó):
 * - `started`: esperando o cliente autorizar no Cloudflare;
 * - `code_received`: o worker vai trocar o código;
 * - `choosing`: mais de uma conta (ou nenhuma que a API do Cloudflare liste): o cliente escolhe;
 * - `done`, `failed` (com o código) e `expired`: terminada.
 */
export const CLOUDFLARE_OAUTH_ATTEMPT_STATUSES = [
  'started',
  'code_received',
  'choosing',
  'done',
  'failed',
  'expired',
] as const;
export type CloudflareOauthAttemptStatus = (typeof CLOUDFLARE_OAUTH_ATTEMPT_STATUSES)[number];
/** As que ainda esperam alguma coisa: só elas vencem. */
export const CLOUDFLARE_OAUTH_OPEN_STATUSES = [
  'started',
  'code_received',
  'choosing',
] as const satisfies readonly CloudflareOauthAttemptStatus[];

/**
 * Por que a tentativa falhou:
 * - `oauth_denied`: o cliente (ou o administrador da conta dele) não autorizou;
 * - `oauth_code_rejected`: o Cloudflare recusou a troca do código (vencido ou já usado);
 * - `oauth_client_rejected`: o Cloudflare recusou o app ou os escopos (problema da Verax);
 * - `oauth_no_refresh`: a resposta veio sem a renovação;
 * - `oauth_scope_missing` / `oauth_scope_unexpected`: os escopos concedidos não são os pedidos;
 * - `oauth_no_account`: nenhuma conta autorizada com leitura da auditoria;
 * - `oauth_account_mismatch`: na reconexão, a conta autorizada não é a cadastrada;
 * - `account_exists`: a conta já está cadastrada e não pode ser ligada;
 * - `plan_limit_reached` / `tenant_plan_missing`: sem vaga no plano do cliente, ou o nó ainda sem o plano;
 * - `source_unavailable`: o Cloudflare não respondeu;
 * - `internal_error`: qualquer outra falha (detalhe só no log do nó).
 */
export const CLOUDFLARE_OAUTH_ATTEMPT_ERRORS = [
  'oauth_denied',
  'oauth_code_rejected',
  'oauth_client_rejected',
  'oauth_no_refresh',
  'oauth_scope_missing',
  'oauth_scope_unexpected',
  'oauth_no_account',
  'oauth_account_mismatch',
  'account_exists',
  'plan_limit_reached',
  'tenant_plan_missing',
  'source_unavailable',
  'internal_error',
] as const;
export type CloudflareOauthAttemptError = (typeof CLOUDFLARE_OAUTH_ATTEMPT_ERRORS)[number];

/** As contas de uma mesma autorização que o painel aceita ligar de uma vez. */
export const CLOUDFLARE_OAUTH_MAX_ACCOUNTS = 50;

/**
 * Uma conta da autorização e se ela pode ser monitorada: disponível, já cadastrada por este cliente (será ligada à
 * autorização), sem leitura da auditoria ou sem resposta do Cloudflare.
 */
export const CLOUDFLARE_OAUTH_ACCOUNT_STATES = [
  'available',
  'registered',
  'forbidden',
  'unavailable',
] as const;
export const cloudflareOauthAccountSchema = z.strictObject({
  accountId: cloudflareAccountIdSchema,
  /** O nome da conta no Cloudflare, cortado; null quando a API não o dá. */
  name: z.string().max(120).nullable(),
  state: z.enum(CLOUDFLARE_OAUTH_ACCOUNT_STATES),
});
export type CloudflareOauthAccount = z.infer<typeof cloudflareOauthAccountSchema>;

/** Resposta de `GET /v1/cloudflare-oauth/attempts/:id`. Nenhum segredo: nem `state`, nem código, nem token. */
export const cloudflareOauthAttemptSchema = z
  .strictObject({
    id: z.uuid(),
    status: z.enum(CLOUDFLARE_OAUTH_ATTEMPT_STATUSES),
    errorCode: z.enum(CLOUDFLARE_OAUTH_ATTEMPT_ERRORS).nullable(),
    accounts: z.array(cloudflareOauthAccountSchema).max(CLOUDFLARE_OAUTH_MAX_ACCOUNTS),
    /** O Cloudflare não listou as contas: em `choosing`, o painel pede o ID digitado. */
    accountIdRequired: z.boolean(),
    /** As contas cadastradas no nó ligadas pela tentativa (em `done`). */
    cloudAccountIds: z.array(z.uuid()).max(CLOUDFLARE_OAUTH_MAX_ACCOUNTS),
    expiresAt: z.iso.datetime(),
  })
  .refine((attempt) => (attempt.status === 'failed') === (attempt.errorCode !== null), {
    error: 'código incompatível com a situação',
  });
export type CloudflareOauthAttempt = z.infer<typeof cloudflareOauthAttemptSchema>;

/** Corpo de `POST /v1/cloudflare-oauth/attempts/:id/accounts`: as contas que o cliente quer monitorar. */
export const cloudflareOauthChooseSchema = z.strictObject({
  accountIds: z
    .array(cloudflareAccountIdSchema)
    .min(1)
    .max(CLOUDFLARE_OAUTH_MAX_ACCOUNTS)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'conta repetida' }),
});
export type CloudflareOauthChoose = z.infer<typeof cloudflareOauthChooseSchema>;

/** A concessão (`CloudflareGrant`): em uso, esperando o cliente reconectar ou sendo revogada no Cloudflare. */
export const CLOUDFLARE_GRANT_STATUSES = ['active', 'reconnect', 'revoking'] as const;
export type CloudflareGrantStatus = (typeof CLOUDFLARE_GRANT_STATUSES)[number];

/**
 * A autorização foi revogada, venceu ou o Cloudflare recusou a renovação: a coleta para até o cliente conectar de novo.
 * Vai em `connectionError` e é um dos `CLOUDFLARE_BLOCKING_ERRORS`.
 */
export const CLOUDFLARE_OAUTH_RECONNECT_ERROR =
  'oauth_reconnect_required' as const satisfies CloudflareBlockingError;
/** O Cloudflare recusou o app da Verax na renovação: não depende do cliente e não para o que ainda vale. */
export const CLOUDFLARE_OAUTH_CLIENT_ERROR = 'oauth_client_rejected';

/**
 * Resposta de `GET /v1/cloud-accounts/:id/cloudflare-connection`: por onde a conta é lida hoje. Rota à parte porque
 * `cloudAccountSchema` é estrito e um painel anterior recusaria um campo novo.
 */
export const cloudflareConnectionSchema = z
  .strictObject({
    method: z.enum(CLOUDFLARE_CONNECT_MODES).nullable(),
    grant: z
      .strictObject({
        status: z.enum(CLOUDFLARE_GRANT_STATUSES),
        consentedAt: z.iso.datetime(),
        lastRefreshAt: z.iso.datetime().nullable(),
        scopes: z.array(z.string().max(CLOUDFLARE_OAUTH_MAX_SCOPE_LENGTH)).max(CLOUDFLARE_OAUTH_MAX_SCOPES),
        /** Quantas contas cadastradas usam a mesma autorização. */
        accounts: z.number().int().min(1),
      })
      .nullable(),
  })
  .refine((connection) => (connection.method === 'oauth') === (connection.grant !== null), {
    error: 'autorização incompatível com o modo',
  });
export type CloudflareConnection = z.infer<typeof cloudflareConnectionSchema>;

/**
 * A situação de uma zona (domínio) da conta nos eventos de segurança:
 * - `pending`: achada e ainda não lida;
 * - `reading`: a última janela foi lida;
 * - `not_entitled`: o plano da zona não dá o dado;
 * - `forbidden`: sem permissão de leitura na zona;
 * - `over_limit`: além do máximo de zonas lidas por conta;
 * - `not_monitored`: fora da lista cadastrada;
 * - `missing`: não aparece mais na conta (a linha fica, como histórico).
 */
export const CLOUDFLARE_ZONE_STATES = [
  'pending',
  'reading',
  'not_entitled',
  'forbidden',
  'over_limit',
  'not_monitored',
  'missing',
] as const;
export type CloudflareZoneState = (typeof CLOUDFLARE_ZONE_STATES)[number];

export const cloudflareZoneSchema = z
  .strictObject({
    zoneId: z.string().regex(/^[0-9a-f]{32}$/),
    name: z.string().min(1).max(253),
    plan: z.string().max(64).nullable(),
    state: z.enum(CLOUDFLARE_ZONE_STATES),
    lastReadAt: z.iso.datetime().nullable(),
    lastErrorCode: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
      .nullable(),
    firstSeenAt: z.iso.datetime(),
    missingSince: z.iso.datetime().nullable(),
  })
  .refine((zone) => (zone.state === 'missing') === (zone.missingSince !== null), {
    error: 'data incompatível com a situação',
  });
export type CloudflareZone = z.infer<typeof cloudflareZoneSchema>;

/** Resposta de `GET /v1/cloud-accounts/:id/cloudflare-zones`. Vale também para a conta com token colado. */
export const cloudflareZonesSchema = z.strictObject({
  /** Todas, inclusive as novas (a lista cadastrada vazia), ou só as da lista. */
  monitored: z.enum(['all', 'listed']),
  /** O máximo de zonas lidas por conta: acima dele, "todas" não é verdade, e a tela diz quais ficaram de fora. */
  limit: z.number().int().min(1),
  zones: z.array(cloudflareZoneSchema),
});
export type CloudflareZones = z.infer<typeof cloudflareZonesSchema>;
