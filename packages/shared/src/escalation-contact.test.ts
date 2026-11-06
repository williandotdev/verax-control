import { describe, expect, it } from 'vitest';
import {
  ESCALATION_CONFIRM_PATH,
  ESCALATION_CONTACT_STATUS_LABELS,
  ESCALATION_CONTACT_STATUSES,
  ESCALATION_UNSUBSCRIBE_PATH,
  escalationContactInputSchema,
  escalationContactResponseSchema,
  escalationContactSchema,
  escalationLinkResultSchema,
  escalationLinkSchema,
} from './escalation-contact.js';
import { hasPermission, ROLES } from './permissions.js';
import { tenantSchema } from './tenants.js';

const token = 'a'.repeat(40) + '_-9';

const contact = {
  name: 'Ana',
  email: 'ana@cliente.example',
  phone: null,
  status: 'pending',
  confirmedAt: null,
  unsubscribedAt: null,
  confirmationEmail: { status: 'sent', at: '2026-11-10T12:00:00.000Z' },
} as const;

describe('contato de escalonamento (D8)', () => {
  it('três estados, cada um com o rótulo do painel', () => {
    expect(ESCALATION_CONTACT_STATUSES).toEqual(['pending', 'confirmed', 'unsubscribed']);
    expect(ESCALATION_CONTACT_STATUS_LABELS).toEqual({
      pending: 'Aguardando confirmação',
      confirmed: 'Confirmado',
      unsubscribed: 'Descadastrado',
    });
  });

  it('o cadastro aceita nome, e-mail e telefone opcional; o estado nunca vem do corpo', () => {
    expect(escalationContactInputSchema.parse({ name: ' Ana ', email: 'ana@cliente.example' })).toEqual({
      name: 'Ana',
      email: 'ana@cliente.example',
    });
    for (const extra of [
      { status: 'confirmed' },
      { confirmedAt: '2026-11-10T12:00:00.000Z' },
      { tenantId: 'x' },
    ]) {
      expect(
        escalationContactInputSchema.safeParse({ name: 'Ana', email: 'ana@cliente.example', ...extra })
          .success,
      ).toBe(false);
    }
    expect(escalationContactInputSchema.safeParse({ name: 'Ana', email: 'ana' }).success).toBe(false);
  });

  it('o contato lido traz o estado e o último e-mail de confirmação, e o cadastro do cliente o usa', () => {
    expect(escalationContactSchema.parse(contact)).toEqual(contact);
    expect(
      escalationContactSchema.parse({ ...contact, confirmationEmail: null }).confirmationEmail,
    ).toBeNull();
    expect(escalationContactSchema.safeParse({ ...contact, status: 'ativo' }).success).toBe(false);
    expect(escalationContactResponseSchema.parse({ contact: null })).toEqual({ contact: null });
    const tenant = {
      id: '018f0000-0000-7000-8000-000000000001',
      name: 'Cliente Demo A',
      status: 'active',
      cnpj: null,
      plan: null,
      escalationContact: contact,
      createdAt: '2026-11-10T12:00:00.000Z',
      updatedAt: '2026-11-10T12:00:00.000Z',
    };
    expect(tenantSchema.parse(tenant).escalationContact).toEqual(contact);
    expect(
      tenantSchema.safeParse({
        ...tenant,
        escalationContact: { name: 'Ana', email: 'a@b.example', phone: null },
      }).success,
    ).toBe(false);
  });

  it('o link leva só o token, de 43 caracteres em base64url', () => {
    expect(escalationLinkSchema.parse({ token })).toEqual({ token });
    for (const body of [
      {},
      { token: token.slice(1) },
      { token: `${token.slice(1)}=` },
      { token: `${token.slice(1)}.` },
      { token, tenantId: 'x' },
      { token, email: 'ana@cliente.example' },
    ]) {
      expect(escalationLinkSchema.safeParse(body).success).toBe(false);
    }
    expect(escalationLinkResultSchema.parse({ status: 'unsubscribed' })).toEqual({ status: 'unsubscribed' });
    expect(escalationLinkResultSchema.safeParse({ status: 'confirmed', email: 'x' }).success).toBe(false);
  });

  it('as páginas dos links são públicas e fixas', () => {
    expect(ESCALATION_CONFIRM_PATH).toBe('/escalonamento/confirmar');
    expect(ESCALATION_UNSUBSCRIBE_PATH).toBe('/escalonamento/descadastrar');
  });

  it('só administradores leem e mudam o contato do próprio cliente', () => {
    for (const permission of ['escalation_contact:read', 'escalation_contact:write'] as const) {
      expect(ROLES.filter((role) => hasPermission(role, permission))).toEqual([
        'admin_verax',
        'admin_cliente',
      ]);
    }
  });
});
