import { z } from 'zod';
import { AWS_SOURCE_STATES, awsSourceIdSchema } from './aws-onboarding.js';
import { cloudAccountRefSchema } from './cloud-accounts.js';
import { paginatedSchema, withPagination } from './pagination.js';
import { GIB_BYTES } from './plan-usage.js';

/**
 * Ataques web pelos logs de acesso do ALB: o contrato da configuração do cliente (`/v1/web-logs`). Os balanceadores com a
 * estimativa de volume e as regras de leitura de cada um, as fontes confiáveis e as rotas declaradas.
 *
 * - Só existe no nó com `AWS_WEB_LOGS_ENABLED` ligado. Desligado, toda rota daqui responde 404 (`WEB_LOGS_DISABLED`), como
 *   num nó de antes, que não as tem: o painel trata os dois do mesmo jeito.
 * - São rotas à parte do onboarding: o contrato dele é estrito, e um campo novo na resposta derrubaria a tela inteira de
 *   um painel de antes.
 * - A permissão é a das contas cloud (`cloud_accounts:read` e `cloud_accounts:write`): todos leem, administradores mudam.
 *   Uma permissão nova iria na resposta do `GET /v1/me`, que um painel de antes recusaria inteira.
 * - Os formatos são os que o motor aceita (`apps/api/src/weblogs/trusted-sources.ts` e `routes.ts`), e os CHECK do banco os
 *   repetem. Aqui pode ser mais estrito, nunca mais largo (`apps/api/test/web-logs-contract.test.ts`).
 */

/** Tudo em `/v1/web-logs` está desligado neste nó. */
export const WEB_LOGS_DISABLED_CODE = 'WEB_LOGS_DISABLED';

/**
 * Os códigos das recusas (o `code` do erro da API), além de `WEB_LOGS_DISABLED`:
 * - `SOURCE_NOT_AUTHORIZED`: o modo e o multiplicador são do balanceador autorizado;
 * - `WEB_OBSERVATION_PENDING`: `alert` antes do fim da observação obrigatória (`observeUntil`);
 * - `WEB_TRUSTED_LIMIT_REACHED` e `WEB_ROUTE_LIMIT_REACHED`: o teto de fontes confiáveis e o de rotas;
 * - `WEB_TRUSTED_DUPLICATE` e `WEB_ROUTE_DUPLICATE`: a mesma faixa, ou a mesma rota, já existe ali;
 * - `WEB_TRUSTED_EXPIRY_INVALID`: validade no passado, ou além de 365 dias;
 * - `WEB_ESTIMATE_RATE_LIMITED`: estimativa do mesmo balanceador pedida há menos de 5 min;
 * - `SOURCE_NOT_AVAILABLE` e `SOURCE_PERMISSION_MISSING`: não dá para estimar um balanceador sem log ou sem permissão;
 * - `ACCOUNT_NOT_CONNECTED`: a conta não está conectada;
 * - `WEB_ALB_LOGGING_PENDING`: já há um pedido de ligar ou desligar o log deste balanceador esperando o worker;
 * - `WEB_ALB_LOGGING_ALREADY_ON`: a descoberta já vê o log ligado (ou a Verax já o ligou): nada a ligar;
 * - `WEB_ALB_LOGGING_NOT_ALB`: só o log de um ALB é ligado pelo painel;
 * - `WEB_ALB_LOGGING_NOT_VERAX`: desligar só vale para o log que a Verax ligou;
 * - `WEB_ALB_LOGGING_SOURCE_AUTHORIZED`: retire a autorização do balanceador antes de desligar o log dele.
 */
export const WEB_LOGS_ERROR_CODES = [
  'SOURCE_NOT_AUTHORIZED',
  'SOURCE_NOT_AVAILABLE',
  'SOURCE_PERMISSION_MISSING',
  'ACCOUNT_NOT_CONNECTED',
  'WEB_OBSERVATION_PENDING',
  'WEB_TRUSTED_LIMIT_REACHED',
  'WEB_TRUSTED_DUPLICATE',
  'WEB_TRUSTED_EXPIRY_INVALID',
  'WEB_ROUTE_LIMIT_REACHED',
  'WEB_ROUTE_DUPLICATE',
  'WEB_ESTIMATE_RATE_LIMITED',
  'WEB_ALB_LOGGING_PENDING',
  'WEB_ALB_LOGGING_ALREADY_ON',
  'WEB_ALB_LOGGING_NOT_ALB',
  'WEB_ALB_LOGGING_NOT_VERAX',
  'WEB_ALB_LOGGING_SOURCE_AUTHORIZED',
] as const;
export type WebLogsErrorCode = (typeof WEB_LOGS_ERROR_CODES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Uma linha de texto: sem caractere de controle. */
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        ![...value].some((char) => {
          const code = char.charCodeAt(0);
          return code < 32 || code === 127;
        }),
      { error: 'caractere de controle não é permitido' },
    );

const userId = z.string().max(64).nullable();
/** Pelo menos um campo no corpo de uma alteração. */
const hasFields = (body: Record<string, unknown>): boolean =>
  Object.values(body).some((value) => value !== undefined);
const NO_FIELDS = { error: 'informe ao menos um campo' };

// --- A estimativa de volume ---

/** Acima desta fração do plano, a autorização pede a confirmação (D1 do desenho). */
export const WEB_ESTIMATE_ACK_PERCENT = 20;
/** A estimativa mais velha que isto não vale para autorizar: o tráfego pode ser outro. */
export const WEB_ESTIMATE_MAX_AGE_MS = 7 * DAY_MS;
/** Uma estimativa por balanceador a cada 5 min (um pedido ainda pendente não conta: ele não é renovado). */
export const WEB_ESTIMATE_REQUEST_INTERVAL_MS = 5 * 60 * 1000;
/** Os dias que a projeção soma contra o volume do mês. */
export const WEB_ESTIMATE_MONTH_DAYS = 30;

/**
 * O resultado da última estimativa: `ready` (com o volume por dia), `no_sample` (o balanceador não gravou nada no dia
 * medido) ou `failed` (a leitura falhou; `errorCode` diz o motivo). Null: nunca calculada.
 */
export const WEB_ESTIMATE_STATUSES = ['ready', 'no_sample', 'failed'] as const;
export type WebEstimateStatus = (typeof WEB_ESTIMATE_STATUSES)[number];

/** Contra o que a projeção é feita: o volume do mês, a franquia do dia, ou nada (o plano sem limite de volume). */
export const WEB_ESTIMATE_BASES = ['monthly', 'franchise', 'none'] as const;
export type WebEstimateBasis = (typeof WEB_ESTIMATE_BASES)[number];

/** O volume que o plano do cliente inclui. */
export interface VolumeAllowance {
  monthlyGib: number | null;
  franchiseGbPerDay: number | null;
}

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/**
 * Quanto o balanceador soma no plano: GB (10^9 bytes) por dia e a porcentagem do volume do mês ou da franquia. Função pura,
 * a mesma na API (que confere a ciência do pedido) e no painel. `bytesPerDay` é null sem amostra.
 *
 * A confirmação é exigida acima de 20% do plano, pelo valor exato e não pelo arredondado; e sempre que o número não diz o
 * volume: sem amostra, ou com a listagem cortada (o valor é um piso).
 */
export function projectWebLogs(
  bytesPerDay: number | null,
  truncated: boolean,
  allowance: VolumeAllowance,
): {
  gbPerDay: number | null;
  percent: number | null;
  basis: WebEstimateBasis;
  acknowledgementRequired: boolean;
} {
  const { monthlyGib, franchiseGbPerDay } = allowance;
  const basis: WebEstimateBasis =
    franchiseGbPerDay !== null ? 'franchise' : monthlyGib !== null ? 'monthly' : 'none';
  if (bytesPerDay === null) return { gbPerDay: null, percent: null, basis, acknowledgementRequired: true };
  const exact =
    franchiseGbPerDay !== null
      ? (100 * bytesPerDay) / (franchiseGbPerDay * 1e9)
      : monthlyGib !== null
        ? (100 * bytesPerDay * WEB_ESTIMATE_MONTH_DAYS) / (monthlyGib * GIB_BYTES)
        : null;
  return {
    gbPerDay: round(bytesPerDay / 1e9, 3),
    percent: exact === null ? null : round(exact, 1),
    basis,
    acknowledgementRequired: truncated || (exact !== null && exact > WEB_ESTIMATE_ACK_PERCENT),
  };
}

export const webEstimateProjectionSchema = z.strictObject({
  /** GB (10^9 bytes) por dia, descompactados: o que o medidor conta. Null sem amostra. */
  gbPerDay: z.number().min(0).nullable(),
  percent: z.number().min(0).nullable(),
  basis: z.enum(WEB_ESTIMATE_BASES),
  /** A autorização só entra com a confirmação do cliente. */
  acknowledgementRequired: z.boolean(),
  /** Até quando a estimativa vale para autorizar. */
  validUntil: z.iso.datetime(),
});
export type WebEstimateProjection = z.infer<typeof webEstimateProjectionSchema>;

export const webEstimateSchema = z.strictObject({
  /** Pedida e ainda não respondida pelo worker. O resultado anterior, se há um, continua à vista. */
  requestedAt: z.iso.datetime().nullable(),
  status: z.enum(WEB_ESTIMATE_STATUSES).nullable(),
  computedAt: z.iso.datetime().nullable(),
  /** O dia (UTC) medido. */
  day: z.iso.date().nullable(),
  /** Os arquivos do balanceador naquele dia. */
  objects: z.number().int().min(0).nullable(),
  /** A listagem foi cortada: o volume é um piso. */
  truncated: z.boolean(),
  errorCode: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
    .nullable(),
  /** Null sem resultado que valha para autorizar, e para quem não lê o plano (`plan:read`). */
  projection: webEstimateProjectionSchema.nullable(),
});
export type WebEstimate = z.infer<typeof webEstimateSchema>;

// --- O estado da leitura ---

/**
 * Os motivos de estado que só a leitura dos logs do ALB grava na fonte (`AwsSource.stateCode`); os outros são os de sempre
 * (`throttled`, o nome do erro da AWS, o motivo da permissão):
 * - `web_gap` (`ingestion_error`): nas últimas 24 h, arquivos com mais de 24 h ficaram sem leitura;
 * - `web_unread` (`stalled`): há arquivo novo, e nada é lido há mais de 2 h;
 * - `web_quarantined` (`collecting`): nas últimas 24 h, algum arquivo foi recusado (quebrado ou grande demais);
 * - `web_prefix_unsupported` (`ingestion_error`): o prefixo do bucket tem um caractere que a leitura não aceita.
 */
export const WEB_SOURCE_STATE_CODES = [
  'web_gap',
  'web_unread',
  'web_quarantined',
  'web_prefix_unsupported',
] as const;
export type WebSourceStateCode = (typeof WEB_SOURCE_STATE_CODES)[number];

// --- A saúde da leitura e a observação ---

/** As contagens da saúde da leitura são das últimas 24 h. */
export const WEB_HEALTH_WINDOW_MS = DAY_MS;
/** Tetos da resposta: regras e níveis da observação, o que as fontes confiáveis calaram e as notas do motor. */
export const WEB_HEALTH_RULES_LIMIT = 64;
export const WEB_HEALTH_SUPPRESSED_LIMIT = 100;
export const WEB_HEALTH_NOTES_LIMIT = 32;

const counter = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Uma regra dos ataques web (`990405`). */
const webRuleId = z.string().regex(/^\d{6}$/);

/** O que teria virado achado enquanto o balanceador só observa. Só contagens. */
export const webObservationSchema = z.strictObject({
  /** O começo da observação: o da autorização, ou o de quando o balanceador foi trocado. */
  since: z.iso.datetime(),
  /** Por regra e nível. */
  rules: z
    .array(
      z.strictObject({
        ruleId: webRuleId,
        level: z.int().min(0).max(15),
        findings: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
        firstSeenAt: z.iso.datetime(),
        lastSeenAt: z.iso.datetime(),
      }),
    )
    .max(WEB_HEALTH_RULES_LIMIT),
  /** Os números são um piso. */
  truncated: z.boolean(),
});
export type WebObservation = z.infer<typeof webObservationSchema>;

/** O que uma fonte confiável calou nas últimas 24 h: quantos endereços, na última avaliação em que houve algum. */
export const webSuppressedSchema = z.strictObject({
  /** O ID da fonte confiável (`WebTrustedSource`); ela pode já ter sido tirada. */
  trustedId: z.string().min(1).max(64),
  ruleId: webRuleId,
  clients: counter,
  lastSeenAt: z.iso.datetime(),
});
export type WebSuppressed = z.infer<typeof webSuppressedSchema>;

/**
 * `GET /v1/web-logs/sources/:sourceId/health`: as contagens da leitura de um balanceador nas últimas 24 h e o resumo da
 * observação. O atraso e a última leitura são os da fonte (`AwsSource.health`, no onboarding). Nunca um endereço, um caminho
 * ou um host: o resumo do dia do motor, o único lugar com IP fora dos achados, não sai daqui.
 *
 * Estrito nos campos e nos tetos, aberto nos códigos (regras e notas): um código novo do nó não derruba a tela de antes.
 */
export const webSourceHealthSchema = z.strictObject({
  sourceId: awsSourceIdSchema,
  /** O começo da janela das contagens. */
  since: z.iso.datetime(),
  /**
   * Os arquivos: lidos na hora, lidos depois de a janela fechar, recusados e deixados sem leitura. Os dois primeiros, pelo
   * horário do tráfego; os dois últimos, por quando foram tratados.
   */
  objects: z.strictObject({ read: counter, late: counter, quarantined: counter, gap: counter }),
  /** As linhas dos arquivos lidos: as analisadas e as deixadas de fora (tortas, grandes demais, de outro balanceador). */
  lines: z.strictObject({ analysed: counter, malformed: counter, oversize: counter, foreign: counter }),
  /** Os bytes descompactados dos arquivos lidos: os que contam no plano. */
  bytes: counter,
  /** O intervalo do tráfego que ficou sem leitura; null sem lacuna, ou se os arquivos não dizem o horário. */
  gap: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }).nullable(),
  /** Null sem observação guardada: nunca lido, sem autorização, ou o balanceador é outro. */
  observation: webObservationSchema.nullable(),
  suppressed: z.array(webSuppressedSchema).max(WEB_HEALTH_SUPPRESSED_LIMIT),
  /** As notas do motor (`behind_proxy`, `truncated`...). */
  notes: z.array(z.string().regex(/^[a-z0-9_]{1,32}$/)).max(WEB_HEALTH_NOTES_LIMIT),
  /** Quando o motor gravou a observação e as notas; null se nunca. */
  stateAt: z.iso.datetime().nullable(),
});
export type WebSourceHealth = z.infer<typeof webSourceHealthSchema>;

// --- A configuração de um balanceador ---

/** `observe`: só conta, sem achado. `alert`: abre achado. */
export const WEB_SOURCE_MODES = ['observe', 'alert'] as const;
export type WebSourceMode = (typeof WEB_SOURCE_MODES)[number];

/** Todo balanceador autorizado começa observando, por 72 h: antes disso, ele não passa a alertar. */
export const WEB_OBSERVE_MS = 72 * 60 * 60 * 1000;
/** O multiplicador dos limites das regras: menor que 1 alerta mais cedo, maior que 1 alerta mais tarde. */
export const WEB_MULTIPLIER_BOUNDS = { min: 0.5, max: 10 } as const;
const multiplier = z.number().min(WEB_MULTIPLIER_BOUNDS.min).max(WEB_MULTIPLIER_BOUNDS.max);

export const webSourceSettingsSchema = z.strictObject({
  mode: z.enum(WEB_SOURCE_MODES),
  observeUntil: z.iso.datetime().nullable(),
  thresholdMultiplier: multiplier,
  updatedAt: z.iso.datetime(),
  updatedBy: userId,
});
export type WebSourceSettings = z.infer<typeof webSourceSettingsSchema>;

/** `PATCH /v1/web-logs/sources/:sourceId/settings`. */
export const webSourceSettingsUpdateSchema = z
  .strictObject({ mode: z.enum(WEB_SOURCE_MODES).optional(), thresholdMultiplier: multiplier.optional() })
  .refine(hasFields, NO_FIELDS);
export type WebSourceSettingsUpdate = z.infer<typeof webSourceSettingsUpdateSchema>;

/** `app/<nome>/<id>`: o balanceador, como a AWS o escreve no ARN e no log. */
export const webLoadBalancerSchema = z.string().regex(/^app\/[A-Za-z0-9-]{1,32}\/[0-9a-f]{16}$/);

/** Um balanceador (`elb_logs`) do cliente: o que é da fonte fica no onboarding; aqui, o que é dos ataques web. */
export const webLogSourceSchema = z.strictObject({
  /** O ID da fonte (`AwsSource`). */
  id: z.uuid(),
  cloudAccountId: z.uuid(),
  accountId: cloudAccountRefSchema,
  region: z.string().max(32),
  name: z.string().max(512),
  /** Null: não é um ALB (NLB ou GWLB), ou a descoberta não guardou o ARN. */
  loadBalancer: webLoadBalancerSchema.nullable(),
  internetFacing: z.boolean().nullable(),
  state: z.enum(AWS_SOURCE_STATES),
  authorized: z.boolean(),
  /** Null até a primeira autorização. Ficam depois de retirada a autorização, e voltam a valer na próxima. */
  settings: webSourceSettingsSchema.nullable(),
  /** Null: nunca pedida. */
  estimate: webEstimateSchema.nullable(),
});
export type WebLogSource = z.infer<typeof webLogSourceSchema>;

/** `GET /v1/web-logs/sources`: os de todas as contas do cliente, ou os de uma, em páginas (nenhum fica de fora). */
export const webLogSourceListQuerySchema = withPagination({ cloudAccountId: z.uuid().optional() });
export type WebLogSourceListQuery = z.infer<typeof webLogSourceListQuerySchema>;
export const webLogSourceListSchema = paginatedSchema(webLogSourceSchema);
export type WebLogSourceList = z.infer<typeof webLogSourceListSchema>;

// --- Fontes confiáveis ---

export const WEB_TRUSTED_KINDS = ['monitor', 'office', 'partner', 'pentest', 'proxy'] as const;
export type WebTrustedKind = (typeof WEB_TRUSTED_KINDS)[number];

/** Por cliente, somadas as que valem para todos os balanceadores e as de cada um: o motor de um nunca recebe mais. */
export const WEB_TRUSTED_LIMIT = 200;
export const WEB_TRUSTED_MAX_VALIDITY_MS = 365 * DAY_MS;

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  // Zero à esquerda é ambíguo (octal em alguns sistemas): recusado.
  if (!parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return null;
  return parts.map(Number);
}

/** Os oito grupos de um IPv6, sem o IPv4 embutido. */
function parseIpv6(text: string): number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const [head = [], tail = []] = halves.map((half) => (half === '' ? [] : half.split(':')));
  const groups = [...head, ...tail];
  if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  const missing = 8 - groups.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...new Array<string>(missing).fill('0'), ...tail].map((group) =>
    Number.parseInt(group, 16),
  );
}

/** A rede não tem bit de máquina: `192.0.2.1/24` não é uma faixa. */
function isNetwork(words: readonly number[], bits: number, prefix: number): boolean {
  return words.every((word, i) => {
    const kept = Math.min(bits, Math.max(0, prefix - i * bits));
    return word % 2 ** (bits - kept) === 0;
  });
}

/**
 * Uma faixa confiável na forma em que é guardada (a mesma faixa escrita de dois jeitos é uma só), ou null fora dos pisos:
 * IPv4 de /16 a /32, IPv6 de /32 a /64 (a contagem é por /64: uma isenção menor calaria o /64 inteiro de quem divide a
 * rede), sem bit de máquina.
 */
export function normalizeTrustedCidr(text: string): string | null {
  const [address = '', prefixText = '', ...rest] = text.split('/');
  if (rest.length > 0 || !/^(?:0|[1-9]\d{0,2})$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const v4 = parseIpv4(address);
  if (v4 !== null) {
    return prefix >= 16 && prefix <= 32 && isNetwork(v4, 8, prefix) ? `${v4.join('.')}/${prefix}` : null;
  }
  const v6 = parseIpv6(address);
  if (v6 === null || prefix < 32 || prefix > 64 || !isNetwork(v6, 16, prefix)) return null;
  // Até o /64, os quatro últimos grupos são zero: é sempre a maior sequência, a que o `::` encurta.
  const groups = v6.slice(0, 4);
  while (groups.length > 0 && groups.at(-1) === 0) groups.pop();
  return `${groups.map((group) => group.toString(16)).join(':')}::/${prefix}`;
}

const trustedCidrInput = z
  .string()
  .trim()
  .max(49)
  .transform((value, ctx) => {
    const cidr = normalizeTrustedCidr(value);
    if (cidr !== null) return cidr;
    ctx.addIssue({
      code: 'custom',
      message: 'faixa inválida: IPv4 de /16 a /32, IPv6 de /32 a /64, sem bit de máquina',
    });
    return z.NEVER;
  });

/** A validade de uma fonte confiável: no futuro, e até 365 dias a partir de agora. */
export function isTrustedExpiryValid(expiresAt: Date, now: Date): boolean {
  const ahead = expiresAt.getTime() - now.getTime();
  return ahead > 0 && ahead <= WEB_TRUSTED_MAX_VALIDITY_MS;
}

export const webTrustedSourceSchema = z.strictObject({
  id: z.uuid(),
  /** Null: vale para todos os balanceadores do cliente. */
  sourceId: awsSourceIdSchema.nullable(),
  cidr: z.string().max(49),
  kind: z.enum(WEB_TRUSTED_KINDS),
  reason: z.string().min(1).max(200),
  expiresAt: z.iso.datetime(),
  /** Vencida, não vale mais (e continua na lista até ser tirada ou renovada). */
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  createdBy: userId,
  updatedAt: z.iso.datetime(),
  updatedBy: userId,
});
export type WebTrustedSource = z.infer<typeof webTrustedSourceSchema>;

export const webTrustedSourceListSchema = z.strictObject({
  items: z.array(webTrustedSourceSchema).max(WEB_TRUSTED_LIMIT),
  limit: z.literal(WEB_TRUSTED_LIMIT),
});
export type WebTrustedSourceList = z.infer<typeof webTrustedSourceListSchema>;

/** `POST /v1/web-logs/trusted-sources`. */
export const webTrustedSourceCreateSchema = z.strictObject({
  sourceId: awsSourceIdSchema.nullable(),
  cidr: trustedCidrInput,
  kind: z.enum(WEB_TRUSTED_KINDS),
  reason: oneLine(200),
  expiresAt: z.iso.datetime(),
});
export type WebTrustedSourceCreate = z.infer<typeof webTrustedSourceCreateSchema>;

/** `PATCH /v1/web-logs/trusted-sources/:id`: a faixa e onde ela vale não mudam (é outra fonte confiável). */
export const webTrustedSourceUpdateSchema = z
  .strictObject({
    kind: z.enum(WEB_TRUSTED_KINDS).optional(),
    reason: oneLine(200).optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .refine(hasFields, NO_FIELDS);
export type WebTrustedSourceUpdate = z.infer<typeof webTrustedSourceUpdateSchema>;

// --- Rotas declaradas ---

export const WEB_ROUTE_KINDS = ['login', 'mfa', 'reset', 'signup', 'api_token', 'ignore'] as const;
export type WebRouteKind = (typeof WEB_ROUTE_KINDS)[number];
export const WEB_ROUTE_METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type WebRouteMethod = (typeof WEB_ROUTE_METHODS)[number];

/** Por balanceador. */
export const WEB_ROUTES_LIMIT = 50;
const MAX_ROUTE_SEGMENTS = 8;
const ROUTE_SEGMENT = /^[a-z0-9._~-]{1,255}$/;

/** Um caminho literal, em minúsculas, com `*` no lugar de um segmento inteiro (nenhuma expressão regular). */
export function isWebRoutePath(path: string): boolean {
  if (path === '/') return true;
  if (!path.startsWith('/') || path.length > 256) return false;
  const segments = path.slice(1).split('/');
  return (
    segments.length <= MAX_ROUTE_SEGMENTS &&
    segments.every(
      // `.` e `..` são resolvidos antes da comparação: uma rota com eles nunca casaria.
      (segment) => segment === '*' || (ROUTE_SEGMENT.test(segment) && segment !== '.' && segment !== '..'),
    )
  );
}

const routeHost = z
  .string()
  .regex(/^[a-z0-9._~-]{1,253}$/, { error: 'host inválido' })
  .nullable();
const routePath = z.string().max(256).refine(isWebRoutePath, {
  error: 'caminho inválido: minúsculas, até 8 segmentos, `*` só no lugar de um segmento inteiro',
});
const statusCodes = z
  .array(z.int().min(100).max(599))
  .max(20)
  .refine((codes) => new Set(codes).size === codes.length, { error: 'código repetido' });

export const webRouteSchema = z.strictObject({
  id: z.uuid(),
  sourceId: awsSourceIdSchema,
  /** Null: qualquer host. */
  host: routeHost,
  method: z.enum(WEB_ROUTE_METHODS),
  path: routePath,
  kind: z.enum(WEB_ROUTE_KINDS),
  /** Vazio: os códigos que o motor presume. */
  failureCodes: statusCodes,
  successCodes: statusCodes,
  multiplier,
  createdAt: z.iso.datetime(),
  createdBy: userId,
  updatedAt: z.iso.datetime(),
  updatedBy: userId,
});
export type WebRoute = z.infer<typeof webRouteSchema>;

export const webRouteListSchema = z.strictObject({
  items: z.array(webRouteSchema).max(WEB_ROUTES_LIMIT),
  limit: z.literal(WEB_ROUTES_LIMIT),
});
export type WebRouteList = z.infer<typeof webRouteListSchema>;

/** O mesmo código não pode ser falha e sucesso. */
export function hasCodeOverlap(failureCodes: readonly number[], successCodes: readonly number[]): boolean {
  return failureCodes.some((code) => successCodes.includes(code));
}
const CODE_OVERLAP = { error: 'o mesmo código não pode ser falha e sucesso', path: ['successCodes'] };

/** `POST /v1/web-logs/sources/:sourceId/routes`. O host e o caminho são guardados em minúsculas. */
export const webRouteCreateSchema = z
  .strictObject({
    host: z.string().trim().toLowerCase().pipe(routeHost.unwrap()).nullable(),
    method: z.enum(WEB_ROUTE_METHODS),
    path: z.string().trim().toLowerCase().pipe(routePath),
    kind: z.enum(WEB_ROUTE_KINDS),
    failureCodes: statusCodes,
    successCodes: statusCodes,
    multiplier,
  })
  .refine((body) => !hasCodeOverlap(body.failureCodes, body.successCodes), CODE_OVERLAP);
export type WebRouteCreate = z.infer<typeof webRouteCreateSchema>;

/** `PATCH /v1/web-logs/sources/:sourceId/routes/:id`: o host, o método e o caminho não mudam (é outra rota). */
export const webRouteUpdateSchema = z
  .strictObject({
    kind: z.enum(WEB_ROUTE_KINDS).optional(),
    failureCodes: statusCodes.optional(),
    successCodes: statusCodes.optional(),
    multiplier: multiplier.optional(),
  })
  .refine(hasFields, NO_FIELDS);
export type WebRouteUpdate = z.infer<typeof webRouteUpdateSchema>;
