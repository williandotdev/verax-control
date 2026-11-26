import { permissionsOf, ROLES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { NAVIGATION, visibleNavigation } from './navigation';

const groupsOf = (role: (typeof ROLES)[number]) =>
  visibleNavigation(permissionsOf(role)).map((group) => [group.label, group.items.map((item) => item.label)]);

describe('menu (R-09)', () => {
  it('três grupos curtos no lugar de "Administração", com os mesmos endereços', () => {
    expect(NAVIGATION.map((group) => group.label)).toEqual([
      'Operação',
      'Fontes',
      'Regras',
      'Conta',
      'Verax',
    ]);
    for (const group of NAVIGATION) expect(group.items.length).toBeLessThanOrEqual(4);
    const addresses = NAVIGATION.flatMap((group) => group.items.map((item) => item.to)).sort();
    expect(addresses).toEqual(
      [
        '/',
        '/alertas-sem-dono',
        '/ativos',
        '/auditoria',
        '/cadastros/agentes',
        '/cadastros/clientes',
        '/cadastros/contas',
        '/cadastros/escalonamento',
        '/cadastros/excecoes',
        '/cadastros/plano',
        '/cadastros/protecao',
        '/cadastros/usuarios',
        '/postura',
      ].sort(),
    );
  });

  it('quem só lê não vê "Administração"; os clientes ficam no grupo da Verax', () => {
    for (const role of ROLES) {
      expect(groupsOf(role).map(([label]) => label)).not.toContain('Administração');
    }
    expect(groupsOf('admin_verax').at(-1)).toEqual(['Verax', ['Clientes', 'Alertas sem dono']]);
    expect(groupsOf('leitura').map(([label]) => label)).not.toContain('Verax');
  });
});
