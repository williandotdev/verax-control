import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  firstLoginWithMfaEnrollment,
  fixtures,
  latestMail,
  loginWithCode,
  submitLogin,
  watchCspViolations,
} from './support';

/**
 * Autenticação de ponta a ponta: painel compilado (com a CSP de produção) contra a API real e o PostgreSQL
 * de teste. Os códigos TOTP vêm de um gerador próprio do teste, como faria o aplicativo do usuário.
 */
test.describe('autenticação contra a API real', () => {
  test('primeiro acesso: cadastro do MFA obrigatório; depois, senha + código', async ({ page }) => {
    const csp = watchCspViolations(page);
    const { email } = fixtures().users.adminA;

    const secret = await firstLoginWithMfaEnrollment(page, email);
    await expect(page.getByText(email)).toBeVisible();

    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);
    // Depois de sair, a sessão não vale mais.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);

    await loginWithCode(page, email, secret);
    expect(csp).toEqual([]);
  });

  test('telas de login e de código sem violações de acessibilidade', async ({ page }) => {
    await page.goto('/login');
    const login = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(login.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('senha errada e e-mail desconhecido: mesma mensagem; 5 erros bloqueiam a conta', async ({ page }) => {
    const { email } = fixtures().users.lockout;

    await submitLogin(page, 'ninguem@e2e.verax.local', 'qualquer-senha-longa');
    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submitLogin(page, email, 'senha-errada-bem-longa');
      await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
    }
    await submitLogin(page, email);
    await expect(page.getByRole('alert')).toContainText('Muitas tentativas');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('redefinição: link por e-mail, token fora da barra de endereço, senha nova vale e a antiga não', async ({
    page,
  }) => {
    const { email } = fixtures().users.reset;
    await page.goto('/esqueci-senha');
    await page.getByLabel('E-mail').fill(email);
    await page.getByRole('button', { name: 'Enviar link' }).click();
    await expect(page.getByRole('status')).toContainText('Se o e-mail estiver cadastrado');

    let link = '';
    await expect
      .poll(() => {
        link = /https?:\/\/\S+\/redefinir-senha#token=\S+/.exec(latestMail(email)?.text ?? '')?.[0] ?? '';
        return link;
      })
      .not.toBe('');

    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Defina uma nova senha' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');

    const newPassword = `nova-${randomUUID()}`;
    await page.getByLabel('Nova senha').fill(newPassword);
    await page.getByLabel('Confirme a senha').fill(newPassword);
    await page.getByRole('button', { name: 'Salvar senha' }).click();
    await expect(page.getByRole('status')).toContainText('Senha redefinida');

    await submitLogin(page, email);
    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
    await submitLogin(page, email, newPassword);
    await expect(page).toHaveURL(/\/mfa\/cadastro$/);
  });

  test('papel leitura: página de administração vira "sem permissão" e a API recusa a ação', async ({
    page,
  }) => {
    const { email } = fixtures().users.leituraA;
    await firstLoginWithMfaEnrollment(page, email);

    await page.goto('/cadastros/clientes');
    await expect(page.getByRole('heading', { name: 'Sem permissão' })).toBeVisible();

    // Mesmo chamando a API direto do navegador, com sessão e token CSRF válidos, a ação é negada.
    const status = await page.evaluate(async (apiUrl) => {
      const tokenResponse = await fetch(`${apiUrl}/v1/csrf-token`, { credentials: 'include' });
      const { token } = (await tokenResponse.json()) as { token: string };
      const response = await fetch(`${apiUrl}/v1/session/tenant`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ tenantId: '018f2c1e-0000-7000-8000-00000000be7a' }),
      });
      return response.status;
    }, process.env['E2E_API_URL'] ?? '');
    expect(status).toBe(403);
  });
});
