import { z } from 'zod';

/**
 * Contato de escalonamento do cliente (decisão D8 da fase 2): quem a Verax e o cliente acionam num incidente grave. Não
 * é usuário do painel (não tem login nem MFA), então só recebe e-mail depois de confirmar que a caixa é dele, só os
 * avisos críticos, e cada e-mail traz o link para deixar de receber.
 *
 * - `pending`: aguardando confirmação. Endereço novo (ou confirmação pedida de novo): nada sai até ele confirmar;
 * - `confirmed`: confirmou pelo link do e-mail. Recebe os avisos críticos;
 * - `unsubscribed`: saiu pelo link de descadastro. Não recebe mais nada até confirmar de novo (um endereço novo ou uma
 *   confirmação pedida por quem administra o cliente).
 */
export const ESCALATION_CONTACT_STATUSES = ['pending', 'confirmed', 'unsubscribed'] as const;
export type EscalationContactStatus = (typeof ESCALATION_CONTACT_STATUSES)[number];

export const ESCALATION_CONTACT_STATUS_LABELS: Readonly<Record<EscalationContactStatus, string>> = {
  pending: 'Aguardando confirmação',
  confirmed: 'Confirmado',
  unsubscribed: 'Descadastrado',
};

/** O link de confirmação vale por este tempo e uma vez só. */
export const ESCALATION_CONFIRMATION_TTL_HOURS = 72;
/** O link de descadastro de cada e-mail vale por um ano, enquanto o endereço e a confirmação forem os mesmos. */
export const ESCALATION_UNSUBSCRIBE_TTL_DAYS = 365;
/**
 * Intervalo mínimo entre dois e-mails de confirmação do mesmo cliente: trocar o endereço ou pedir a confirmação várias
 * vezes seguidas não vira uma rajada de e-mails para endereços de fora (sai só o último pedido).
 */
export const ESCALATION_CONFIRMATION_INTERVAL_MINUTES = 5;

/** Páginas públicas do painel abertas pelos links do e-mail (o token vai no fragmento, `#token=`). */
export const ESCALATION_CONFIRM_PATH = '/escalonamento/confirmar';
export const ESCALATION_UNSUBSCRIBE_PATH = '/escalonamento/descadastrar';

/** O contato como é cadastrado: nome, e-mail e telefone opcional. Substituído inteiro a cada mudança. */
export const escalationContactInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  // No máximo 20 caracteres, o tamanho da coluna no banco.
  phone: z
    .string()
    .trim()
    .max(20)
    .regex(/^\+?[0-9][0-9 ()-]{7,19}$/, { error: 'telefone inválido' })
    .nullable()
    .optional(),
});
export type EscalationContactInput = z.infer<typeof escalationContactInputSchema>;

/** O último e-mail de confirmação do endereço atual: na fila, enviado, falhou nas 5 tentativas ou não saiu. */
export const ESCALATION_CONFIRMATION_EMAIL_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type EscalationConfirmationEmailStatus = (typeof ESCALATION_CONFIRMATION_EMAIL_STATUSES)[number];

/** O contato com o estado dele, como o painel mostra (no cadastro do cliente e na tela do administrador do cliente). */
export const escalationContactSchema = z.strictObject({
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  status: z.enum(ESCALATION_CONTACT_STATUSES),
  confirmedAt: z.iso.datetime().nullable(),
  unsubscribedAt: z.iso.datetime().nullable(),
  /** Nulo quando nenhum e-mail de confirmação foi pedido para o endereço atual (contato anterior a este controle). */
  confirmationEmail: z
    .strictObject({ status: z.enum(ESCALATION_CONFIRMATION_EMAIL_STATUSES), at: z.iso.datetime() })
    .nullable(),
});
export type EscalationContact = z.infer<typeof escalationContactSchema>;

/** `GET /v1/escalation-contact`: o contato do cliente da sessão, ou nenhum. */
export const escalationContactResponseSchema = z.strictObject({
  contact: escalationContactSchema.nullable(),
});
export type EscalationContactResponse = z.infer<typeof escalationContactResponseSchema>;

/** O valor de um link do e-mail: 32 bytes aleatórios em base64url (43 caracteres). */
export const escalationLinkTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Corpo das rotas públicas dos links (`POST /v1/public/escalation-contact/{confirm,unsubscribe}`). */
export const escalationLinkSchema = z.strictObject({ token: escalationLinkTokenSchema });
export type EscalationLink = z.infer<typeof escalationLinkSchema>;

/** Resposta das rotas públicas: só o estado novo, nada do cliente nem do endereço. */
export const escalationLinkResultSchema = z.strictObject({ status: z.enum(['confirmed', 'unsubscribed']) });
export type EscalationLinkResult = z.infer<typeof escalationLinkResultSchema>;

/**
 * A mesma recusa para todo link que não vale: desconhecido, vencido, já usado, de um endereço anterior ou de outro
 * tipo. Não diz qual dos casos, nem de que cliente é.
 */
export const ESCALATION_LINK_INVALID_CODE = 'ESCALATION_LINK_INVALID';
export const ESCALATION_LINK_INVALID_MESSAGE = 'Link inválido ou vencido';
