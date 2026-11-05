import { describe, expect, it } from 'vitest';
import {
  INCIDENT_NOTICE_ROLES,
  NOTICE_CATCH_UP_HOURS,
  NOTICE_DIGEST_ITEMS,
  NOTICE_HOURLY_LIMIT,
  notificationPreferencesSchema,
  notificationPreferencesUpdateSchema,
} from './notification-preferences.js';
import { hasPermission, ROLES } from './permissions.js';

describe("preferência de aviso e resumo por hora (fase 2, PR-17')", () => {
  it('a mudança aceita só o campo da preferência, booleano', () => {
    expect(notificationPreferencesUpdateSchema.parse({ incidentEmails: false })).toEqual({
      incidentEmails: false,
    });
    for (const body of [
      {},
      { incidentEmails: 'false' },
      { incidentEmails: 0 },
      { incidentEmails: null },
      // Ninguém escolhe por outra pessoa nem muda o próprio papel por aqui.
      { incidentEmails: true, userId: 'outra-pessoa' },
      { incidentEmails: true, eligible: true },
    ]) {
      expect(notificationPreferencesUpdateSchema.safeParse(body).success).toBe(false);
    }
  });

  it('a resposta é estrita', () => {
    expect(notificationPreferencesSchema.parse({ incidentEmails: true, eligible: true })).toEqual({
      incidentEmails: true,
      eligible: true,
    });
    expect(
      notificationPreferencesSchema.safeParse({
        incidentEmails: true,
        eligible: true,
        email: 'x@exemplo.com',
      }).success,
    ).toBe(false);
  });

  it('recebem os avisos de incidente administradores e analistas do cliente (D8)', () => {
    expect(INCIDENT_NOTICE_ROLES).toEqual(['admin_cliente', 'analista_cliente']);
  });

  it('limites do resumo: 5 avulsos por hora, 10 itens no resumo e retomada depois de 24 h', () => {
    expect([NOTICE_HOURLY_LIMIT, NOTICE_DIGEST_ITEMS, NOTICE_CATCH_UP_HOURS]).toEqual([5, 10, 24]);
  });

  it('todos leem a própria preferência; mudar é de quem recebe avisos (e da Verax, que a API recusa)', () => {
    for (const role of ROLES) expect(hasPermission(role, 'notification_preferences:read')).toBe(true);
    expect(ROLES.filter((role) => hasPermission(role, 'notification_preferences:write'))).toEqual([
      'admin_verax',
      'admin_cliente',
      'analista_cliente',
    ]);
  });
});
