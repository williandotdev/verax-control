import { describe, expect, it } from 'vitest';
import { hasPermission, isRole, PERMISSIONS, permissionsOf, ROLES, type Permission } from './permissions.js';

describe('matriz de permissões', () => {
  it('admin_verax tem todas as permissões', () => {
    expect(permissionsOf('admin_verax')).toEqual(Object.keys(PERMISSIONS));
  });

  it('leitura só tem permissões de leitura', () => {
    for (const permission of permissionsOf('leitura')) expect(permission).toMatch(/:read$/);
  });

  it('nenhum papel de cliente cadastra clientes, troca de cliente ou vê alertas sem dono', () => {
    const veraxOnly: Permission[] = [
      'tenants:write',
      'tenants:read',
      'session:switch_tenant',
      'unowned_alerts:read',
    ];
    for (const role of ROLES.filter((r) => r !== 'admin_verax')) {
      for (const permission of veraxOnly) expect(hasPermission(role, permission)).toBe(false);
    }
  });

  it('só administradores gerenciam usuários e veem auditoria', () => {
    expect(hasPermission('admin_cliente', 'users:write')).toBe(true);
    expect(hasPermission('analista_cliente', 'users:write')).toBe(false);
    expect(hasPermission('leitura', 'audit:read')).toBe(false);
  });

  it('agentes: todos leem a lista e as instruções; só administradores veem a senha de registro', () => {
    for (const role of ROLES) expect(hasPermission(role, 'agents:read')).toBe(true);
    expect(ROLES.filter((role) => hasPermission(role, 'agents:enroll'))).toEqual([
      'admin_verax',
      'admin_cliente',
    ]);
  });

  it('todo papel referenciado na matriz existe', () => {
    for (const roles of Object.values(PERMISSIONS)) {
      for (const role of roles) expect(isRole(role)).toBe(true);
    }
  });

  it('isRole recusa valores fora da lista', () => {
    expect(isRole('admin_verax')).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
