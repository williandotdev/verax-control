import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  enrollMfa,
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

  test('senha temporária: o administrador cria a conta; no primeiro login, troca a senha e depois o MFA', async ({
    page,
  }) => {
    const csp = watchCspViolations(page);
    await firstLoginWithMfaEnrollment(page, fixtures().users.adminB.email);

    // O administrador cria a conta pela tela de Usuários e vê a senha temporária uma única vez.
    const email = `temporaria-${randomUUID()}@e2e.verax.local`;
    await page.goto('/cadastros/usuarios');
    await page.getByRole('button', { name: 'Criar usuário' }).click();
    const panel = page.getByRole('dialog');
    // Com o painel aberto, a página de trás não rola (trava pelo CSS do painel, sem estilo inline).
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
    await panel.getByLabel('Nome').fill('Pessoa Nova');
    await panel.getByLabel('E-mail').fill(email);
    await panel.getByRole('button', { name: 'Criar usuário' }).click();
    await expect(panel.getByRole('status')).toContainText('criada');
    const temporary = (await panel.locator('code').innerText()).trim();
    const groups = temporary.split('-');
    expect(groups).toHaveLength(4);
    for (const group of groups) expect(group).toMatch(/^[A-HJ-NP-Za-km-z2-9]{5}$/);
    await panel.getByRole('button', { name: 'Concluir' }).click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // Com a senha temporária, só a troca de senha abre; o painel volta para ela.
    await submitLogin(page, email, temporary);
    await expect(page).toHaveURL(/\/trocar-senha$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/trocar-senha$/);

    const newPassword = `nova-${randomUUID()}`;
    await page.getByLabel('Senha temporária', { exact: true }).fill(temporary);
    await page.getByLabel('Nova senha', { exact: true }).fill(newPassword);
    await page.getByLabel('Confirme a nova senha', { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: 'Salvar e continuar' }).click();

    // Em seguida, o cadastro do MFA com a senha nova; depois, o painel.
    await expect(page.getByRole('status')).toContainText('Senha trocada');
    await enrollMfa(page, newPassword);

    await page.getByRole('button', { name: 'Sair' }).click();
    await submitLogin(page, email, temporary);
    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
    expect(csp).toEqual([]);
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
