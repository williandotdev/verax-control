import { z } from 'zod';
import { ALERT_EXCEPTION_FIELDS, alertExceptionSchema } from './alert-exceptions.js';
import { plainText } from './protected-resources.js';
import { alertExceptionBatchResultSchema, scopedExceptionSchema } from './scoped-exceptions.js';

/**
 * Os alertas em aberto que uma exceção nova resolve (decisão do dono de 26/11/2026). Criar uma exceção, de usuário, IP ou
 * recurso ou ampla, resolve também os alertas que ainda estão em aberto (novo ou em análise) e que ela teria marcado se
 * tivessem chegado depois dela: viram "legítimo", ligados à exceção, com um comentário na trilha do alerta. A regra que
 * decide é a mesma da chegada (`apps/api/src/alerts/exception-match.ts` e `scoped-exception-match.ts`).
 *
 * Nunca entram: o alerta já tratado (legítimo ou resolvido) e o que está num incidente ou num caso promovido a incidente
 * (uma pessoa o julgou ameaça): esses ficam, e são contados à parte. Revogar ou apagar a exceção não reabre nada.
 *
 * **Versões diferentes.** As respostas de criar são estritas, e um painel de antes recusaria um campo novo: a contagem só
 * vem para quem a pede (`openAlerts=true`). O painel de antes não pede e recebe a resposta de sempre; os alertas em aberto
 * são resolvidos do mesmo jeito. Um nó de antes recusa o pedido com 400, e o painel novo cria de novo sem ele.
 */

/** Alertas resolvidos numa requisição, no máximo. O restante fica para "resolver os próximos" (`resolve-open`). */
export const EXCEPTION_OPEN_RESOLVE_MAX = 2_000;
/** Alertas por lote: cada lote é uma leitura, uma gravação e os comentários. */
export const EXCEPTION_OPEN_CHUNK = 500;
/** A prévia lê no máximo isto de alertas candidatos; acima disso, a contagem é "pelo menos". */
export const EXCEPTION_OPEN_PREVIEW_SCAN_MAX = 50_000;

/** Os status de quem ainda espera decisão: só estes a exceção resolve. */
export const EXCEPTION_OPEN_STATUSES = ['new', 'investigating'] as const;

const count = z.number().int().min(0);

/** "Vai resolver N alertas em aberto (M em incidentes ficam)". */
export const exceptionOpenPreviewSchema = z.strictObject({
  /** Os alertas em aberto que a exceção resolveria agora. */
  resolve: count,
  /** Os que casam, mas ficam: estão num incidente ou num caso promovido. */
  keptInIncident: count,
  /** False quando a leitura parou no teto (`EXCEPTION_OPEN_PREVIEW_SCAN_MAX`): os números são "pelo menos". */
  complete: z.boolean(),
});
export type ExceptionOpenPreview = z.infer<typeof exceptionOpenPreviewSchema>;

/** O que uma criação (ou um "resolver os próximos") fez com os alertas em aberto. */
export const exceptionOpenResolutionSchema = z.strictObject({
  resolved: count,
  keptInIncident: count,
  /** Parou no teto da requisição (`EXCEPTION_OPEN_RESOLVE_MAX`): ainda há alertas em aberto que ela cobre. */
  more: z.boolean(),
});
export type ExceptionOpenResolution = z.infer<typeof exceptionOpenResolutionSchema>;

/** O pedido da contagem na criação. Só `true`: sem ele, a resposta é a de sempre. */
export const exceptionCreateQuerySchema = z.strictObject({ openAlerts: z.literal('true').optional() });
export type ExceptionCreateQuery = z.infer<typeof exceptionCreateQuerySchema>;

/** A exceção criada, com a contagem quando pedida. */
export const alertExceptionCreatedSchema = alertExceptionSchema.extend({
  openAlerts: exceptionOpenResolutionSchema.optional(),
});
export type AlertExceptionCreated = z.infer<typeof alertExceptionCreatedSchema>;

export const scopedExceptionCreatedSchema = scopedExceptionSchema.extend({
  openAlerts: exceptionOpenResolutionSchema.optional(),
});
export type ScopedExceptionCreated = z.infer<typeof scopedExceptionCreatedSchema>;

export const alertExceptionBatchCreatedSchema = alertExceptionBatchResultSchema.extend({
  openAlerts: exceptionOpenResolutionSchema.optional(),
});
export type AlertExceptionBatchCreated = z.infer<typeof alertExceptionBatchCreatedSchema>;

const isIpOrCidr = (value: string): boolean =>
  [z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()].some((schema) => schema.safeParse(value).success);

/** A prévia da exceção de usuário, IP ou recurso: o mesmo alvo da criação, sem o motivo e a validade. */
export const alertExceptionOpenPreviewQuerySchema = z
  .strictObject({
    ruleId: z.string().regex(/^\d{1,6}$/, { error: 'ID de regra tem até 6 dígitos' }),
    field: z.enum(ALERT_EXCEPTION_FIELDS),
    value: plainText(256),
  })
  .refine((input) => input.field !== 'ip' || isIpOrCidr(input.value), {
    error: 'IP ou faixa CIDR inválida',
    path: ['value'],
  });
export type AlertExceptionOpenPreviewQuery = z.infer<typeof alertExceptionOpenPreviewQuerySchema>;
