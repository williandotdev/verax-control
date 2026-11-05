import { z } from 'zod';
import { type PlanLimitKey, resolvedPlanSchema } from './plans.js';

/**
 * Limites do plano aplicados e "Plano e uso" (fase 2, PR-18). A tabela dos planos fica em `plans.ts`; aqui, o que ocupa
 * vaga, a recusa e o contrato do `GET /v1/plan`.
 */

/** Código da recusa (409) por limite do plano: o painel reconhece a resposta por ele. */
export const PLAN_LIMIT_REACHED_CODE = 'PLAN_LIMIT_REACHED';

/**
 * O que ocupa vaga no plano. Só a criação e a reativação pedem vaga; descer de plano não desativa nem apaga nada (o
 * painel mostra "acima do limite do plano", e só a próxima criação é recusada).
 * - `cloudAccounts`: as contas ativas (AWS, GCP e Cloudflare); desativar libera a vaga;
 * - `users`: os usuários do cliente convidados ou ativos; desativar libera a vaga, e a equipe da Verax (`admin_verax`)
 *   nunca conta.
 */
export const PLAN_SEATS = ['cloudAccounts', 'users'] as const;
export type PlanSeat = (typeof PLAN_SEATS)[number];

/** O limite do plano que vale para cada vaga. */
export const PLAN_SEAT_LIMIT: Readonly<Record<PlanSeat, PlanLimitKey>> = {
  cloudAccounts: 'maxCloudAccounts',
  users: 'maxUsers',
};

/** Mensagem da recusa, a mesma na API e na demonstração. Diz o limite e o que fazer, sem citar outro cliente. */
export function planLimitMessage(seat: PlanSeat, limit: number): string {
  const one = limit === 1;
  return seat === 'cloudAccounts'
    ? `Seu plano permite até ${limit} ${one ? 'conta cloud ativa' : 'contas cloud ativas'}. Desative uma conta ou fale com a Verax para ampliar.`
    : `Seu plano permite até ${limit} ${one ? 'usuário' : 'usuários'}. Desative um usuário ou fale com a Verax para ampliar.`;
}

/** 1 GiB em bytes: o volume do plano é contado em GiB (2³⁰ bytes), sobre os bytes do medidor de uso. */
export const GIB_BYTES = 1024 ** 3;

/** A partir desta fração do volume incluído no mês, o painel mostra a faixa de aviso. */
export const PLAN_VOLUME_WARNING_RATIO = 0.8;

/** Mês do uso, no calendário de Brasília: `AAAA-MM`. */
export const usageMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: 'mês no formato AAAA-MM' });

/**
 * `GET /v1/plan`: o plano do nó (rótulo e limites, já com os ajustes do ambiente) e o uso do cliente da sessão. Os
 * limites vêm sempre da configuração do nó (`PLAN` e `PLAN_*`); o painel só mostra, nunca edita.
 */
export const planUsageSchema = z.strictObject({
  plan: resolvedPlanSchema,
  usage: z.strictObject({
    /** Contas cloud ativas. */
    cloudAccounts: z.number().int().min(0),
    /** Usuários do cliente convidados ou ativos. */
    users: z.number().int().min(0),
    /** Mês do volume, no calendário de Brasília (o mesmo do medidor). */
    month: usageMonthSchema,
    /** Bytes lidos no mês, somadas todas as fontes. */
    monthlyBytes: z.number().int().min(0),
  }),
});
export type PlanUsage = z.infer<typeof planUsageSchema>;

/**
 * Fração do volume do mês já usada (1 = tudo o que o plano inclui); `null` quando o plano não tem limite de volume.
 * Pode passar de 1: acima do plano a coleta continua, nada é descartado.
 */
export function planVolumeRatio({ plan, usage }: Pick<PlanUsage, 'plan' | 'usage'>): number | null {
  const gib = plan.limits.monthlyGib;
  return gib === null ? null : usage.monthlyBytes / (gib * GIB_BYTES);
}
