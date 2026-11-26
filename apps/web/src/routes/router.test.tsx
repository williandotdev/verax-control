import { describe, expect, it } from 'vitest';
import routerSource from './router.tsx?raw';

/**
 * E-13 da auditoria de UX: o painel por tela. O login e as telas de entrada ficam no arquivo principal; as telas do
 * painel entram por \`import()\`, cada uma no arquivo dela. Conferido no código do roteador: um import estático de uma
 * tela do painel a traria de volta para o arquivo que o login baixa.
 */
const ROUTER: string = routerSource;

const LAZY_PAGES = [
  'detections-page',
  'posture-page',
  'assets-page',
  'admin/tenants-page',
  'admin/users-page',
  'admin/cloud-accounts-page',
  'agents-page',
  'admin/protected-resources-page',
  'admin/exceptions-page',
  'admin/plan-page',
  'admin/escalation-contact-page',
  'audit-page',
  'unowned-alerts-page',
  'account-page',
  'mfa-enroll-page',
];

describe('roteador: cada tela do painel no arquivo dela (E-13)', () => {
  it.each(LAZY_PAGES)('%s entra por import() e não por import estático', (page) => {
    expect(ROUTER).toContain(`import('@/pages/${page}')`);
    expect(ROUTER).not.toContain(`from '@/pages/${page}'`);
  });

  it('a entrada continua no arquivo principal: login, código, senha, sem permissão e não encontrada', () => {
    for (const page of [
      'login-page',
      'mfa-verify-page',
      'forgot-password-page',
      'set-password-page',
      'not-found-page',
    ]) {
      expect(ROUTER).toContain(`from '@/pages/${page}'`);
    }
  });
});
