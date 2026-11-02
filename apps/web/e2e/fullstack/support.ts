import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { totp } from './totp';

export interface E2eFixtures {
  tenants: { a: string; b: string };
  users: Record<
    'adminVerax' | 'adminA' | 'leituraA' | 'adminB' | 'lockout' | 'reset',
    { email: string; id: string }
  >;
}

export const FIXTURES_FILE = (): string =>
  join(process.env['E2E_MAILBOX_DIR'] ?? '', '..', 'verax-e2e-fixtures.json');

export function fixtures(): E2eFixtures {
  return JSON.parse(readFileSync(FIXTURES_FILE(), 'utf8')) as E2eFixtures;
}

export const password = (): string => process.env['E2E_PASSWORD'] ?? '';

/** Última mensagem da caixa de e-mail de teste para o endereço (a API grava arquivos JSON). */
export function latestMail(email: string): { subject: string; text: string } | undefined {
  const directory = process.env['E2E_MAILBOX_DIR'] ?? '';
  const messages = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
          to: string;
          subject: string;
          text: string;
        },
    )
    .filter((message) => message.to === email);
  return messages.at(-1);
}

/** Falha o teste se o navegador recusar algo pela CSP (a mesma de produção). */
export function watchCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  return violations;
}

export async function submitLogin(page: Page, email: string, secret = password()): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(secret);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

/** Primeiro login de um usuário: cadastra o MFA pela tela e devolve o segredo (o "aplicativo" do teste). */
export async function firstLoginWithMfaEnrollment(page: Page, email: string): Promise<string> {
  await submitLogin(page, email);
  await expect(page).toHaveURL(/\/mfa\/cadastro$/);
  await page.getByLabel('Senha').fill(password());
  await page.getByRole('button', { name: 'Continuar' }).click();

  await expect(page.getByRole('img', { name: 'QR code para o aplicativo autenticador' })).toBeVisible();
  const secret = (await page.locator('code').first().innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await expect(page.getByRole('list', { name: 'Códigos de recuperação' }).getByRole('listitem')).toHaveCount(
    10,
  );

  await page.getByLabel('Guardei os códigos em local seguro').check();
  await page.getByLabel('Código do aplicativo').fill(totp(secret));
  await page.getByRole('button', { name: 'Ativar e entrar' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu principal' })).toBeVisible();
  return secret;
}

/** Login completo de quem já tem MFA. Usa o código da próxima janela (o atual pode já ter sido usado). */
export async function loginWithCode(page: Page, email: string, secret: string): Promise<void> {
  await submitLogin(page, email);
  await expect(page).toHaveURL(/\/login\/codigo$/);
  await page.getByLabel('Código do aplicativo').fill(totp(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu principal' })).toBeVisible();
}
