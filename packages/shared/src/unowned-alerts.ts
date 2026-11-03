import { z } from 'zod';
import { withPagination } from './pagination.js';

/**
 * Fila de alertas sem dono (T5.2): o que o sync não atribuiu a nenhum cliente, porque na dúvida o alerta não é de
 * ninguém. Não pertence a cliente algum, então só a equipe da Verax vê. Guarda o mínimo para a triagem, nunca o
 * evento bruto.
 */
export const UNOWNED_REASONS = [
  'invalid_alert',
  'not_aws',
  'unknown_source',
  'ambiguous_source',
  'no_account',
  'conflicting_accounts',
  'unknown_account',
  'source_mismatch',
] as const;
export type UnownedReason = (typeof UNOWNED_REASONS)[number];

export const UNOWNED_PERIODS = ['24h', '7d', '30d', '90d'] as const;
export type UnownedPeriod = (typeof UNOWNED_PERIODS)[number];

const account = z.string().min(1).max(320);

export const unownedAlertListQuerySchema = withPagination({
  reason: z.enum(UNOWNED_REASONS).optional(),
  period: z.enum(UNOWNED_PERIODS).optional(),
  /** Só os alertas que citam esta conta. */
  account: account.optional(),
});
export type UnownedAlertListQuery = z.infer<typeof unownedAlertListQuerySchema>;

export const unownedAlertSchema = z.strictObject({
  id: z.uuid(),
  source: z.string().max(16),
  reason: z.enum(UNOWNED_REASONS),
  /** Contas citadas no evento, quando o formato permitiu ler. */
  accounts: z.array(account).max(64),
  occurredAt: z.iso.datetime().nullable(),
  ruleId: z.string().max(6).nullable(),
  ruleLevel: z.number().int().min(0).max(16).nullable(),
  title: z.string().max(500).nullable(),
  /** Quando entrou na fila. */
  createdAt: z.iso.datetime(),
});
export type UnownedAlert = z.infer<typeof unownedAlertSchema>;

export const unownedAccountsQuerySchema = z.strictObject({ period: z.enum(UNOWNED_PERIODS).default('30d') });
export type UnownedAccountsQuery = z.infer<typeof unownedAccountsQuerySchema>;

/**
 * As contas que mais aparecem na fila no período, para a pergunta que a fila quase sempre responde: qual conta falta
 * cadastrar (ou está cadastrada no cliente errado).
 */
export const unownedAccountsSchema = z.strictObject({
  period: z.enum(UNOWNED_PERIODS),
  from: z.iso.datetime(),
  items: z
    .array(
      z.strictObject({
        account,
        alerts: z.number().int().min(0),
        lastSeenAt: z.iso.datetime(),
        /** Onde a conta está cadastrada hoje, se estiver: alertas antigos podem ser de antes do cadastro. */
        registeredIn: z
          .strictObject({ tenantId: z.uuid(), tenantName: z.string().max(200), active: z.boolean() })
          .nullable(),
      }),
    )
    .max(50),
});
export type UnownedAccounts = z.infer<typeof unownedAccountsSchema>;
