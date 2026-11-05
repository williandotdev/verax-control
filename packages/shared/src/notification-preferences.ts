import { z } from 'zod';
import type { TenantRole } from './users.js';

/**
 * Papéis que recebem os avisos de incidente e de achado crítico por e-mail (decisão D8 da fase 2): quem administra e
 * quem analisa o cliente. `leitura` não recebe, e a equipe da Verax não é do cliente. Só esses papéis escolhem receber
 * ou não (`PUT /v1/notification-preferences`).
 */
export const INCIDENT_NOTICE_ROLES: readonly TenantRole[] = ['admin_cliente', 'analista_cliente'];

/** E-mails avulsos por pessoa numa hora; do 6º em diante, os avisos da hora vêm num resumo só (fase 2, PR-17'). */
export const NOTICE_HOURLY_LIMIT = 5;
/** Avisos listados no resumo; os que passam disso aparecem como "e mais N". */
export const NOTICE_DIGEST_ITEMS = 10;
/** Aviso com mais que isto na fila não sai sozinho: vem no resumo de retomada. */
export const NOTICE_CATCH_UP_HOURS = 24;

/**
 * Preferência de aviso da própria pessoa (`GET /v1/notification-preferences`). Cada pessoa vê e muda só a dela.
 */
export const notificationPreferencesSchema = z.strictObject({
  /**
   * Recebe por e-mail os avisos de incidente alto ou crítico e de achado crítico. Padrão: sim. Os avisos do plano e da
   * coleta da AWS, que vão para quem administra o cliente, não dependem dela. Vem `false` para quem não recebe avisos.
   */
  incidentEmails: z.boolean(),
  /** O papel da pessoa recebe avisos por e-mail (`INCIDENT_NOTICE_ROLES`). Sem ele, não há o que escolher. */
  eligible: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** Mudança da própria preferência (`PUT /v1/notification-preferences`). */
export const notificationPreferencesUpdateSchema = z.strictObject({
  incidentEmails: z.boolean(),
});
export type NotificationPreferencesUpdate = z.infer<typeof notificationPreferencesUpdateSchema>;

/** Mensagem da recusa para quem não recebe avisos (o papel `leitura` e a equipe da Verax). */
export const NOTICES_NOT_FOR_ROLE_MESSAGE = 'O seu papel não recebe avisos por e-mail';
