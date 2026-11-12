import { z } from 'zod';
import {
  gcpProjectIdSchema,
  isPubsubSubscriptionName,
  SINK_WRITER_IDENTITY_PATTERN,
} from './cloud-accounts.js';
import { FRANCHISE_GB_PER_DAY_BOUNDS, tenantPlanProblems, tenantPlanSchema } from './plans.js';

/**
 * O canal entre o plano de controle e a célula compartilhada (CE-05 e CE-06; `docs/ARQUITETURA.md`, "Canal entre o
 * plano de controle e a célula"). Pub/Sub nos dois sentidos, e este é o contrato dos dois lados:
 *
 * - **Comandos** (plano de controle → célula), no tópico de comandos da célula, com a chave de ordenação = o id do
 *   cliente. `tenant.upsert` é o estado desejado INTEIRO do cliente, com uma `generation` que só cresce: a célula
 *   ignora a geração já aplicada (ou mais velha), então repetir um comando nunca desfaz nada. `tenant.export`,
 *   `tenant.purge` e `tenant.collection_pause` são pedidos pontuais, cada um com o próprio id.
 * - **Relatórios** (célula → plano de controle), no tópico de relatórios da célula, entregues ao `cp-worker` por uma
 *   assinatura push com OIDC. O plano de controle confere que todo cliente citado está nesta célula.
 *
 * Tudo é estrito: um campo a mais, um tipo desconhecido ou uma versão diferente é recusado inteiro, dos dois lados. O
 * painel e o nó andam juntos (o painel de cada cliente roda a versão da célula), mas o plano de controle e a célula, não:
 * uma mudança no contrato sobe `CELL_PROTOCOL_VERSION`, e os dois lados precisam aceitar a nova antes de alguém
 * passar a mandá-la.
 *
 * Os ids de cliente no canal são os do plano de controle (ULID, `tenants/{id}` no Firestore). A célula guarda o mapa
 * para o id dela (`CellTenantState.controlPlaneId`); o plano de controle nunca vê o id do banco da célula.
 *
 * Nada aqui leva segredo, senha, token ou dado pessoal: a senha do primeiro administrador nunca passa pelo canal (o host
 * da célula a escreve no cofre do cliente).
 */
export const CELL_PROTOCOL_VERSION = 1 as const;

/** O maior corpo de uma mensagem do canal, em bytes do JSON (o Pub/Sub aceita 10 MB; o estado desejado é pequeno). */
export const CELL_MESSAGE_MAX_BYTES = 256 * 1024;

/** O maior valor de `generation` (cabe num inteiro de 32 bits do banco da célula). */
export const CELL_GENERATION_MAX = 2_147_483_647;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Id de cliente no canal: o do plano de controle (ULID). */
export const cellTenantIdSchema = z.string().regex(ULID_PATTERN, { error: 'id de cliente inválido' });

/** Id de um comando ou de um pedido (`exportId`, `purgeId`, `requestId`): ULID do plano de controle. */
const ulidSchema = z.string().regex(ULID_PATTERN, { error: 'id inválido' });

/** Id da célula: minúsculas, dígitos e hífen, de 3 a 32 caracteres (`verax-celula`, `sp1`). */
export const cellIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/, { error: 'célula inválida' });

/**
 * Subdomínio do cliente: a regra do `slugSchema` do plano de controle e do `isTenantSlug` da API e do painel (3 a 16
 * caracteres, sem hífen na 3.ª e na 4.ª posições).
 */
const slugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,14}[a-z0-9]$/, { error: 'subdomínio inválido' })
  .refine((value) => value.slice(2, 4) !== '--', { error: 'subdomínio inválido' });

/** Dia do calendário de Brasília, `AAAA-MM-DD` (o dia da medição e do ciclo de cobrança). */
export const cellDaySchema = z.iso.date({ error: 'dia inválido: use AAAA-MM-DD' });

/** Instante em UTC, ISO 8601 com `Z` (como `Date.toISOString()`). */
const instantSchema = z.iso.datetime({ error: 'instante inválido: use ISO 8601 em UTC' });

const generationSchema = z.number().int().min(1).max(CELL_GENERATION_MAX);

/** Sem caracteres de controle (quebra de linha, tabulação, NUL): o nome vai a e-mail, painel e trilha. */
function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** A razão social, como o plano de controle a aceita (`companyNameSchema`) e o nó a guarda (`Tenant.name`, 120). */
const companyNameSchema = z
  .string()
  .min(2)
  .max(120)
  .refine((value) => value.trim() === value && hasNoControlCharacters(value), { error: 'nome inválido' });

/** Rótulo de DNS em minúsculas: 1 a 63 caracteres entre `a-z`, `0-9` e `-`, sem hífen nas pontas. */
function isDnsLabel(label: string): boolean {
  return /^[a-z0-9-]{1,63}$/.test(label) && !label.startsWith('-') && !label.endsWith('-');
}

/** Nome de DNS em minúsculas, com dois ou mais rótulos e sem ponto no fim (o endereço da API e o do painel). */
const hostnameSchema = z
  .string()
  .max(253)
  .refine((value) => value.split('.').length >= 2 && value.split('.').every(isDnsLabel), {
    error: 'endereço inválido',
  });

/**
 * A identidade do cliente na nuvem (§3.1 do desenho): a conta de serviço `vxt-<slug>` criada pelo `envs/cell-tenant`. A
 * célula emite o token dela para ler a AWS do cliente, e o papel do cliente confia no `saUniqueId`. Só o comando do
 * plano de controle a grava na célula (`TenantCloudIdentity`); nenhuma rota da API a aceita.
 */
export const cellCloudIdentitySchema = z.strictObject({
  saEmail: z
    .string()
    .max(254)
    .regex(/^vxt-[a-z0-9-]{3,16}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/, {
      error: 'conta de serviço do cliente inválida',
    }),
  /** O ID único da conta de serviço (21 dígitos), o `sub` do token do Google. */
  saUniqueId: z.string().regex(/^[0-9]{21}$/, { error: 'ID único da conta de serviço inválido' }),
});
export type CellCloudIdentity = z.infer<typeof cellCloudIdentitySchema>;

/** `projects/<projeto>/topics/<id>`, com as regras do ID da GCP (o mesmo subconjunto da assinatura). */
export function isPubsubTopicName(name: string): boolean {
  const parts = name.split('/');
  if (parts.length !== 4 || parts[0] !== 'projects' || parts[2] !== 'topics') return false;
  const [, project = '', , id = ''] = parts;
  return (
    gcpProjectIdSchema.safeParse(project).success &&
    /^[A-Za-z][A-Za-z0-9._-]{2,254}$/.test(id) &&
    !id.toLowerCase().startsWith('goog')
  );
}

const topicNameSchema = z.string().max(320).refine(isPubsubTopicName, { error: 'tópico inválido' });
const subscriptionNameSchema = z
  .string()
  .max(320)
  .refine(isPubsubSubscriptionName, { error: 'assinatura inválida' });

/**
 * Uma fonte da GCP do cliente já pronta (CE-08): o tópico e a assinatura que o plano de controle criou para aquela conta
 * (nomes com o UUID da conta, nunca reaproveitados).
 */
export const cellGcpSourceSchema = z.strictObject({
  /** A conta cloud da célula (o id do banco da célula, que o pedido `gcp_source.request` trouxe). */
  cloudAccountId: z.uuid(),
  projectId: gcpProjectIdSchema,
  topic: topicNameSchema,
  subscription: subscriptionNameSchema,
});
export type CellGcpSource = z.infer<typeof cellGcpSourceSchema>;

const franchiseGbPerDaySchema = z
  .number()
  .int()
  .min(FRANCHISE_GB_PER_DAY_BOUNDS.min)
  .max(FRANCHISE_GB_PER_DAY_BOUNDS.max);

/**
 * A franquia em vigor a partir de cada dia (§6.2): F_d é a da entrada mais recente com `from ≤ d`. Espelha os itens
 * reais da assinatura na Stripe, e uma redução já marcada aparece como uma entrada com `from` no ciclo seguinte.
 */
export const cellFranchiseEntrySchema = z.strictObject({
  from: cellDaySchema,
  gbPerDay: franchiseGbPerDaySchema,
});
export type CellFranchiseEntry = z.infer<typeof cellFranchiseEntrySchema>;

/** O ciclo de cobrança em curso, em dias de Brasília, com as duas pontas incluídas. */
export const cellBillingPeriodSchema = z
  .strictObject({ start: cellDaySchema, end: cellDaySchema })
  .refine((period) => period.start <= period.end, { error: 'o ciclo termina antes de começar' });
export type CellBillingPeriod = z.infer<typeof cellBillingPeriodSchema>;

/**
 * O último ciclo fechado e cobrado (§6.2, passo 4): o painel mostra exatamente o que foi faturado ("Ciclo anterior: X
 * GB/dia excedentes, faturado em …"). O excedente vai em centésimos de GB/dia, a unidade do medidor da Stripe.
 */
export const cellBilledCycleSchema = z.strictObject({
  periodStart: cellDaySchema,
  periodEnd: cellDaySchema,
  overageHundredthsGbPerDay: z.number().int().min(0).max(100_000_000),
  /** Quando o excedente foi enviado à Stripe (ausente: o ciclo fechou sem excedente). */
  reportedAt: instantSchema.optional(),
});
export type CellBilledCycle = z.infer<typeof cellBilledCycleSchema>;

/**
 * Os preços da tabela publicada que o diálogo "Ampliar franquia" mostra (§6.3), em centavos. O valor em si fica na
 * tabela de preços do plano de controle, fora do repositório; a célula só repete o que recebe, nunca calcula preço.
 */
export const cellUnitPricesSchema = z.strictObject({
  currency: z.literal('brl'),
  /** O GB/dia adicional, por mês, em centavos. */
  additionalGbPerDayCents: z.number().int().min(0).max(100_000_000),
  /** O excedente, por centésimo de GB/dia, em centavos com casas decimais (o `unit_amount_decimal` da Stripe). */
  overageHundredthCentsDecimal: z.string().max(22).refine(isDecimalCents, { error: 'valor inválido' }),
});
export type CellUnitPrices = z.infer<typeof cellUnitPricesSchema>;

/** Até 9 dígitos inteiros e, se houver, até 12 decimais depois do ponto (o formato do `unit_amount_decimal`). */
function isDecimalCents(value: string): boolean {
  const [whole = '', fraction, ...rest] = value.split('.');
  return (
    rest.length === 0 &&
    /^[0-9]{1,9}$/.test(whole) &&
    (fraction === undefined || /^[0-9]{1,12}$/.test(fraction))
  );
}

/** Os estados que o plano de controle manda à célula: o espelho de `Tenant.status` (o `purging` é do `tenant.purge`). */
export const CELL_TENANT_STATUSES = ['active', 'suspended', 'canceled'] as const;
export type CellTenantStatus = (typeof CELL_TENANT_STATUSES)[number];

/** O estado desejado de um cliente na célula: tudo o que o `tenant.upsert` grava, inteiro a cada geração. */
export const cellTenantStateSchema = z
  .strictObject({
    slug: slugSchema,
    name: companyNameSchema,
    /** O endereço da API (`api-<slug>.<domínio>`) e o do painel (`<slug>.control.<domínio>`), no mesmo domínio. */
    hosts: z.strictObject({ api: hostnameSchema, panel: hostnameSchema }),
    status: z.enum(CELL_TENANT_STATUSES),
    plan: tenantPlanSchema,
    /** Em ordem de `from`, sem dia repetido. Só a Plataforma tem franquia; os outros planos mandam a lista vazia. */
    franchiseSchedule: z.array(cellFranchiseEntrySchema).max(400),
    /** O ciclo de cobrança em curso; null fora da cobrança por volume (o plano interno, por exemplo). */
    billingPeriod: cellBillingPeriodSchema.nullable(),
    cloudIdentity: cellCloudIdentitySchema,
    gcpSources: z.array(cellGcpSourceSchema).max(100),
    /** Os IPs de saída da célula (o `/32` que o papel de leitura do cliente aceita). */
    natIps: z.array(z.ipv4()).min(1).max(4),
    lastBilledCycle: cellBilledCycleSchema.nullable(),
    unitPrices: cellUnitPricesSchema.nullable(),
  })
  .superRefine((state, ctx) => {
    for (const problem of tenantPlanProblems(state.plan)) {
      ctx.addIssue({ code: 'custom', path: ['plan', ...problem.field.split('.')], message: problem.message });
    }
    const domainOf = (host: string, prefix: string): string | null =>
      host.startsWith(prefix) ? host.slice(prefix.length) : null;
    const apiDomain = domainOf(state.hosts.api, `api-${state.slug}.`);
    const panelDomain = domainOf(state.hosts.panel, `${state.slug}.control.`);
    if (apiDomain === null || panelDomain === null || apiDomain !== panelDomain) {
      ctx.addIssue({
        code: 'custom',
        path: ['hosts'],
        message: 'os endereços não são do subdomínio do cliente no mesmo domínio',
      });
    }
    const platform = state.plan.planId === 'plataforma';
    if (platform !== state.franchiseSchedule.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['franchiseSchedule'],
        message: platform ? 'obrigatória no plano plataforma' : 'só o plano plataforma tem franquia',
      });
    }
    state.franchiseSchedule.forEach((entry, index) => {
      const previous = state.franchiseSchedule[index - 1];
      if (previous !== undefined && previous.from >= entry.from) {
        ctx.addIssue({
          code: 'custom',
          path: ['franchiseSchedule', index, 'from'],
          message: 'fora de ordem ou repetido',
        });
      }
    });
    const accounts = new Set(state.gcpSources.map((source) => source.cloudAccountId));
    if (accounts.size !== state.gcpSources.length) {
      ctx.addIssue({ code: 'custom', path: ['gcpSources'], message: 'conta repetida' });
    }
    if (new Set(state.natIps).size !== state.natIps.length) {
      ctx.addIssue({ code: 'custom', path: ['natIps'], message: 'IP repetido' });
    }
  });
export type CellTenantState = z.infer<typeof cellTenantStateSchema>;

// --- Comandos ---------------------------------------------------------------------------------------------------

/** O que todo comando leva: a versão, o id do comando, a célula de destino, o cliente e quando saiu. */
const commandEnvelope = {
  v: z.literal(CELL_PROTOCOL_VERSION),
  commandId: ulidSchema,
  cellId: cellIdSchema,
  tenantId: cellTenantIdSchema,
  issuedAt: instantSchema,
} as const;

export const tenantUpsertCommandSchema = z.strictObject({
  ...commandEnvelope,
  kind: z.literal('tenant.upsert'),
  generation: generationSchema,
  state: cellTenantStateSchema,
});

/**
 * Exportar os dados do cliente para o bucket de exportações da célula (§3.7, D): a célula responde `export.ready`.
 * Repetir o mesmo `exportId` repete o relatório, sem exportar de novo.
 */
export const tenantExportCommandSchema = z.strictObject({
  ...commandEnvelope,
  kind: z.literal('tenant.export'),
  exportId: ulidSchema,
});

/**
 * Apagar os dados do cliente da célula (§3.7, D+1). Leva o subdomínio como confirmação: a célula recusa se ele não for
 * o do cliente, se o cliente não estiver cancelado ou se a exportação não estiver gravada.
 */
export const tenantPurgeCommandSchema = z.strictObject({
  ...commandEnvelope,
  kind: z.literal('tenant.purge'),
  purgeId: ulidSchema,
  confirmSlug: slugSchema,
});

/** Por que a coleta de um cliente foi pausada pelo responsável (§3.8): volume fora do normal ou decisão dele. */
export const COLLECTION_PAUSE_REASONS = ['runaway_volume', 'owner'] as const;

/** Pausar (ou retomar) a coleta do cliente sem mudar o estado dele (§3.8). Os dados e o acesso ficam. */
export const tenantCollectionPauseCommandSchema = z
  .strictObject({
    ...commandEnvelope,
    kind: z.literal('tenant.collection_pause'),
    paused: z.boolean(),
    reason: z.enum(COLLECTION_PAUSE_REASONS).optional(),
  })
  .refine((command) => command.paused === (command.reason !== undefined), {
    error: 'o motivo vai só com a pausa',
    path: ['reason'],
  });

export const cellCommandSchema = z.discriminatedUnion('kind', [
  tenantUpsertCommandSchema,
  tenantExportCommandSchema,
  tenantPurgeCommandSchema,
  tenantCollectionPauseCommandSchema,
]);
export type CellCommand = z.infer<typeof cellCommandSchema>;
export type CellCommandKind = CellCommand['kind'];
export const CELL_COMMAND_KINDS = [
  'tenant.upsert',
  'tenant.export',
  'tenant.purge',
  'tenant.collection_pause',
] as const satisfies readonly CellCommandKind[];

// --- Relatórios -------------------------------------------------------------------------------------------------

/** O que todo relatório leva: a versão, um id único (a idempotência do plano de controle), a célula e quando saiu. */
const reportEnvelope = {
  v: z.literal(CELL_PROTOCOL_VERSION),
  reportId: z.uuid(),
  cellId: cellIdSchema,
  emittedAt: instantSchema,
} as const;

/** A célula aplicou a geração do estado desejado (o plano de controle espera por ela no provisionamento). */
export const tenantAppliedReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('tenant.applied'),
  tenantId: cellTenantIdSchema,
  generation: generationSchema,
});

/** Agregados do cliente (no lugar dos guest attributes do nó dedicado): a ativação lê `accountsConnected`. */
export const tenantStatusReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('tenant.status'),
  tenantId: cellTenantIdSchema,
  accountsConnected: z.number().int().min(0).max(10_000),
  lastEventAt: instantSchema.nullable(),
});

const usageSourceSchema = z.strictObject({
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  events: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/**
 * O volume de um dia de Brasília, por fonte (§4, "Relatórios e fechamento"), em bytes descomprimidos. Os valores são
 * absolutos (o dia inteiro até agora), então reenviar é idempotente. `final` só depois das 06:00 de D+1; depois dele, uma
 * correção é registrada, mas não cobrada.
 */
export const usageDailyReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('usage.daily'),
  tenantId: cellTenantIdSchema,
  day: cellDaySchema,
  final: z.boolean(),
  sources: z.strictObject({
    aws: usageSourceSchema.optional(),
    gcp: usageSourceSchema.optional(),
    cloudflare: usageSourceSchema.optional(),
  }),
});

/** A exportação pedida está no bucket de exportações da célula. */
export const exportReadyReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('export.ready'),
  tenantId: cellTenantIdSchema,
  exportId: ulidSchema,
  /** O objeto no bucket de exportações: `<célula>/<cliente>/<arquivo>.tar.gz`. */
  object: z.string().regex(/^[a-z0-9-]{3,32}\/[0-9A-HJKMNP-TV-Z]{26}\/[A-Za-z0-9._-]{1,128}\.tar\.gz$/, {
    error: 'objeto da exportação inválido',
  }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/** Os dados do cliente saíram do banco da célula. */
export const tenantPurgedReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('tenant.purged'),
  tenantId: cellTenantIdSchema,
  purgeId: ulidSchema,
});

/** O administrador do cliente pediu outra franquia pelo painel (§6.3); o plano de controle decide e cobra. */
export const franchiseRequestedReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('franchise.requested'),
  tenantId: cellTenantIdSchema,
  requestId: ulidSchema,
  targetGbPerDay: franchiseGbPerDaySchema,
  /** O usuário da célula que pediu (o id do banco da célula, para a auditoria dos dois lados). */
  requestedBy: z.uuid(),
});

/** O cliente cadastrou um projeto da GCP: a célula pede o tópico e a assinatura (§3.2). */
export const gcpSourceRequestReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('gcp_source.request'),
  tenantId: cellTenantIdSchema,
  cloudAccountId: z.uuid(),
  projectId: gcpProjectIdSchema,
  writerIdentity: z.string().max(128).regex(SINK_WRITER_IDENTITY_PATTERN),
});

const percentSchema = z.number().min(0).max(100).nullable();

/** A saúde da célula para a página "Células" do console (§3.6): só agregados, nunca dado de cliente. */
export const cellStatusReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('cell.status'),
  tenants: z.number().int().min(0).max(10_000),
  cpuPercent: percentSchema,
  memoryPercent: percentSchema,
  diskFreePercent: percentSchema,
  analysisdQueuePercent: percentSchema,
  eventsDropped: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  wodleLagSeconds: z
    .number()
    .int()
    .min(0)
    .max(31 * 24 * 3600)
    .nullable(),
});

/**
 * Por que a célula recusou um comando (o comando foi lido e confirmado; nada dele foi aplicado):
 * - `tenant_unknown`: o comando não é `tenant.upsert` e a célula não conhece o cliente;
 * - `tenant_purging`: o cliente já está em expurgo, e só o expurgo mexe nele;
 * - `slug_conflict`: o subdomínio é de outro cliente, ou o cliente já tem outro;
 * - `identity_conflict`: a conta de serviço já é de outro cliente da célula;
 * - `transition_refused`: o estado pedido não sai do estado atual (`tenant-lifecycle.ts`);
 * - `export_not_canceled`, `purge_not_canceled`: exportação e expurgo só com o cliente cancelado;
 * - `purge_slug_mismatch`: a confirmação não é o subdomínio do cliente;
 * - `purge_export_missing`: o expurgo só depois da exportação gravada;
 * - `export_unavailable`, `purge_unavailable`: a célula ainda não sabe fazer (CE-16).
 */
export const CELL_REFUSAL_CODES = [
  'tenant_unknown',
  'tenant_purging',
  'slug_conflict',
  'identity_conflict',
  'transition_refused',
  'export_not_canceled',
  'export_unavailable',
  'purge_not_canceled',
  'purge_slug_mismatch',
  'purge_export_missing',
  'purge_unavailable',
] as const;
export type CellRefusalCode = (typeof CELL_REFUSAL_CODES)[number];

/** A célula leu um comando válido e não o aplicou; o plano de controle decide o que fazer (alerta, nova tentativa). */
export const commandRefusedReportSchema = z.strictObject({
  ...reportEnvelope,
  kind: z.literal('command.refused'),
  tenantId: cellTenantIdSchema,
  commandId: ulidSchema,
  command: z.enum(CELL_COMMAND_KINDS),
  code: z.enum(CELL_REFUSAL_CODES),
});

export const cellReportSchema = z.discriminatedUnion('kind', [
  tenantAppliedReportSchema,
  tenantStatusReportSchema,
  usageDailyReportSchema,
  exportReadyReportSchema,
  tenantPurgedReportSchema,
  franchiseRequestedReportSchema,
  gcpSourceRequestReportSchema,
  cellStatusReportSchema,
  commandRefusedReportSchema,
]);
export type CellReport = z.infer<typeof cellReportSchema>;
export type CellReportKind = CellReport['kind'];
export const CELL_REPORT_KINDS = [
  'tenant.applied',
  'tenant.status',
  'usage.daily',
  'export.ready',
  'tenant.purged',
  'franchise.requested',
  'gcp_source.request',
  'cell.status',
  'command.refused',
] as const satisfies readonly CellReportKind[];

/** O corpo de um relatório, sem o envelope (que quem publica preenche: versão, id, célula e instante). */
export type CellReportBody = CellReport extends infer R
  ? R extends CellReport
    ? Omit<R, 'v' | 'reportId' | 'cellId' | 'emittedAt'>
    : never
  : never;

/** O id do cliente que o relatório cita (do plano de controle), ou null no `cell.status`. */
export function cellReportTenantId(report: CellReport): string | null {
  return report.kind === 'cell.status' ? null : report.tenantId;
}

// --- Codificação ------------------------------------------------------------------------------------------------

/** O resultado de ler uma mensagem do canal: o valor, ou o motivo da recusa (sem o conteúdo, que não vai a log). */
export type CellParseResult<T> =
  { ok: true; value: T } | { ok: false; reason: 'too_large' | 'not_json' | 'invalid'; issues: string[] };

/** Bytes do texto em UTF-8, sem `TextEncoder` nem `Buffer` (este pacote também vai para o navegador). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Os caminhos e os motivos de cada problema, nunca os valores recebidos. */
function issuesOf(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
}

function parseJsonWith<T>(schema: z.ZodType<T>, text: string): CellParseResult<T> {
  if (text.length > CELL_MESSAGE_MAX_BYTES || utf8ByteLength(text) > CELL_MESSAGE_MAX_BYTES) {
    return { ok: false, reason: 'too_large', issues: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'not_json', issues: [] };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'invalid', issues: issuesOf(parsed.error) };
}

/**
 * Lê um comando do texto JSON de uma mensagem (o `data` do Pub/Sub já decodificado do base64 por quem recebe: a
 * decodificação fica em cada app, que tem o `Buffer` do Node).
 */
export function parseCellCommandJson(text: string): CellParseResult<CellCommand> {
  return parseJsonWith(cellCommandSchema, text);
}

/** Lê um relatório do texto JSON de uma entrega push do Pub/Sub (já decodificado do base64). */
export function parseCellReportJson(text: string): CellParseResult<CellReport> {
  return parseJsonWith(cellReportSchema, text);
}

/** O JSON de um comando ou relatório para publicar, conferido de novo no schema e no teto de tamanho. */
export function cellMessageJson(message: CellCommand | CellReport): string {
  const checked =
    'commandId' in message && 'issuedAt' in message
      ? cellCommandSchema.parse(message)
      : cellReportSchema.parse(message);
  const json = JSON.stringify(checked);
  if (utf8ByteLength(json) > CELL_MESSAGE_MAX_BYTES)
    throw new RangeError('mensagem do canal da célula acima do teto');
  return json;
}
