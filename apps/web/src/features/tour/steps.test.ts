import { type Permission, permissionsOf, ROLES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { NAVIGATION } from '@/layout/navigation';
import { TOUR_STEPS, tourStepsFor, VERAX_SITE } from './steps';

/** A permissão que a rota exige (a mesma do menu; o detalhe do incidente segue a lista). */
function routePermission(path: string): Permission | undefined {
  const { pathname } = new URL(path, 'http://painel.local');
  if (/^\/incidentes\/[^/]+$/.test(pathname)) return 'incidents:read';
  return NAVIGATION.flatMap((group) => group.items).find((item) => item.to === pathname)?.permission;
}

describe('percurso do tour', () => {
  it('passos com id único, título e texto curto', () => {
    const ids = TOUR_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of TOUR_STEPS) {
      expect(step.title.length, step.id).toBeGreaterThan(0);
      expect(step.body.length, step.id).toBeLessThanOrEqual(300);
    }
  });

  it.each(ROLES)('%s: de 12 a 18 passos, só por telas que o papel abre', (role) => {
    const permissions = permissionsOf(role);
    const steps = tourStepsFor(permissions);
    expect(steps.length).toBeGreaterThanOrEqual(12);
    expect(steps.length).toBeLessThanOrEqual(18);
    for (const step of steps.filter((candidate) => candidate.path)) {
      const permission = routePermission(step.path ?? '');
      expect(permission, step.id).toBeDefined();
      expect(permissions, step.id).toContain(permission);
    }
  });

  it('começa na Torre e termina no convite para o site, sem destaque', () => {
    expect(TOUR_STEPS[0]?.path).toBe('/');
    const last = TOUR_STEPS.at(-1);
    expect(last?.target).toBeUndefined();
    expect(last?.title).toBe('Gostou? Contrate pelo site');
    expect(last?.link?.href).toBe(VERAX_SITE);
    expect(VERAX_SITE).toBe('https://veraxsistemas.com.br');
  });

  it('os passos exclusivos da Verax e dos administradores saem do tour de quem não os vê', () => {
    const analyst = tourStepsFor(permissionsOf('analista_cliente')).map((step) => step.id);
    expect(analyst).not.toContain('seletor-cliente');
    expect(analyst).not.toContain('alertas-sem-dono');
    expect(analyst).not.toContain('auditoria');
    expect(analyst).not.toContain('usuarios');
    expect(tourStepsFor(permissionsOf('admin_verax'))).toHaveLength(TOUR_STEPS.length);
  });

  it('os exemplos (incidente e achado) vêm do cliente da sessão, com a lista como reserva', () => {
    const examples = TOUR_STEPS.filter((step) => step.example);
    expect(examples.map((step) => [step.id, step.example, step.path])).toEqual([
      ['incidente', 'incident', '/incidentes'],
      ['achado-triagem', 'finding', '/achados'],
    ]);
  });
});
