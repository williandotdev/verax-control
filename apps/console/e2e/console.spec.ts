import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { createFakeState, type FakeAdminState } from '../src/mocks/fake-admin-api';
import {
  FICTITIOUS_LOGIN_PHRASE,
  FICTITIOUS_SETUP_TOKEN,
  FICTITIOUS_TOTP_CODE,
  LOGIN_FAILED_MESSAGE,
} from '../src/mocks/fake-auth';
import { FICTITIOUS_OWNER } from '../src/mocks/fixtures';
import { mockAdminApi } from './mock-api';

/**
 * As telas do console no navegador, nos dois temas: sem violação do axe (WCAG 2.2 AA), sem violação da CSP do
 * cp-admin e navegáveis pelo teclado. As capturas (com a tabela e o modelo FICTÍCIOS) vão para `CONSOLE_SCREENSHOTS`,
 * quando definida, ou para a pasta do teste.
 */
const THEMES = ['light', 'dark'] as const;

async function prepare(
  page: Page,
  theme: (typeof THEMES)[number],
  state: FakeAdminState = createFakeState(),
): Promise<string[]> {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) violations.push(message.text());
  });
  page.on('pageerror', (error) => violations.push(error.message));
  await page.addInitScript((value) => window.localStorage.setItem('verax.console.theme', value), theme);
  await mockAdminApi(page, state);
  return violations;
}

async function audit(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);
  const directory = process.env['CONSOLE_SCREENSHOTS'];
  if (directory !== undefined) mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: directory === undefined ? testInfo.outputPath(`${name}.png`) : join(directory, `${name}.png`),
    fullPage: true,
  });
}

for (const theme of THEMES) {
  test.describe(`tema ${theme === 'light' ? 'claro' : 'escuro'}`, () => {
    test('modelos de custo: a lista e o rascunho novo com o erro de campo da API', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/modelos-de-custo');
      await expect(page.getByTestId('usuario')).toHaveText('responsavel@verax.example');
      await expect(page.getByRole('row', { name: /^custos-teste-v1/ })).toContainText('Vigente');
      await audit(page, testInfo, `modelos-de-custo-${theme}`);

      await page.getByRole('link', { name: 'Novo rascunho' }).click();
      await expect(page.getByLabel('Câmbio (R$ por US$)')).toHaveValue('2');
      await page.getByLabel('Margem de alerta (%)').fill('10');
      await page.getByRole('button', { name: 'Criar rascunho' }).click();
      await expect(page.getByLabel('Margem de alerta (%)')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('alert').first()).toContainText('margins.alert');
      await audit(page, testInfo, `modelo-de-custos-erro-${theme}`);
      expect(violations).toEqual([]);
    });

    test('tabela de preços: a checagem reprovada e a publicação recusada com o relatório', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/tabelas-de-preco/teste-v3');
      await page.getByLabel('Suporte prioritário (R$)').fill('1,00');
      await page.getByRole('button', { name: 'Salvar rascunho' }).click();
      await expect(page.getByText('Rascunho salvo.')).toBeVisible();
      await page.getByRole('button', { name: 'Conferir' }).click();
      await expect(page.getByRole('region', { name: 'Checagem de teste-v3' })).toContainText('Reprovada');
      await page.getByRole('button', { name: 'Publicar…' }).click();
      await page.getByRole('button', { name: 'Confirmar a publicação' }).click();
      await expect(page.getByRole('region', { name: 'Publicação recusada pela checagem' })).toBeVisible();
      await audit(page, testInfo, `tabela-de-precos-recusada-${theme}`);
      expect(violations).toEqual([]);
    });

    test('clientes: a lista, o contrato direto com a cotação e a confirmação, e a linha do tempo de quem parou', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/clientes');
      await expect(page.getByRole('row', { name: /Cliente Demo A Ltda/ })).toContainText(
        'Provisionamento parou',
      );
      await audit(page, testInfo, `clientes-${theme}`);

      await page.getByRole('link', { name: 'Novo cliente (contrato direto)' }).click();
      await expect(page.getByLabel('Contas de nuvem')).toHaveValue('2');
      await page.getByLabel('Razão social').fill('Cliente Demo D Ltda');
      await page.getByLabel('CNPJ').fill('11.222.333/0001-81');
      await page.getByLabel('E-mail do administrador do cliente').fill('admin@cliente-demo-d.example');
      await page.getByLabel('Subdomínio').fill('cliente-demo-d');
      await page.getByRole('radio', { name: 'Infraestrutura da Verax' }).check();
      await page.getByRole('button', { name: 'Calcular a cotação' }).click();
      await expect(page.getByRole('region', { name: 'Cotação de referência' })).toContainText('R$ 1.000,00');
      await page.getByRole('button', { name: 'Revisar e confirmar…' }).click();
      await page.getByLabel(/Digite o subdomínio/).fill('cliente-demo-d');
      await expect(page.getByRole('button', { name: 'Criar e provisionar' })).toBeEnabled();
      await audit(page, testInfo, `cliente-novo-${theme}`);
      await page.getByRole('button', { name: 'Criar e provisionar' }).click();
      await expect(page.getByText('Cliente criado. O provisionamento começou.')).toBeVisible();
      await audit(page, testInfo, `cliente-criado-${theme}`);

      await page.goto('/clientes/01JC0000000000000000000A01');
      const provisioning = page.getByRole('region', { name: 'Provisionamento' });
      await expect(provisioning).toContainText('cloudflare_denied');
      await provisioning.getByRole('button', { name: 'Retomar provisionamento…' }).click();
      await expect(
        provisioning.getByRole('button', { name: 'Confirmar: retomar provisionamento' }),
      ).toBeDisabled();
      await audit(page, testInfo, `cliente-parado-${theme}`);

      // Um contrato direto ativo: cancelar no fim do contrato, com a data e a confirmação.
      await page.goto('/clientes/01JC0000000000000000000D01');
      const lifecycle = page.getByRole('region', { name: 'Ciclo de vida' });
      await lifecycle.getByRole('button', { name: 'Cancelar contrato…' }).click();
      await lifecycle.getByLabel('Cancelar em').fill('2027-01-31');
      await lifecycle.getByLabel(/Digite o subdomínio/).fill('contrato-ativo');
      await lifecycle.getByRole('button', { name: 'Confirmar: cancelar contrato' }).click();
      await expect(lifecycle.getByText(/Cancelamento marcado para 31\/01\/2027/)).toBeVisible();
      await lifecycle.getByRole('button', { name: 'Suspender…' }).click();
      await audit(page, testInfo, `cliente-ciclo-de-vida-${theme}`);
      expect(violations).toEqual([]);
    });

    test('clientes no cliente: o cadastro com a licença, sem provisionar, e o detalhe com a versão e o guia', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/clientes/novo');
      await expect(page.getByLabel('Contas de nuvem')).toHaveValue('2');
      await page.getByLabel('Razão social').fill('Cliente Demo H Ltda');
      await page.getByLabel('CNPJ').fill('11.222.333/0001-81');
      await page.getByLabel('E-mail do administrador do cliente').fill('admin@cliente-demo-h.example');
      await page.getByLabel('Subdomínio').fill('cliente-demo-h');
      // Sem escolher onde roda: o problema no grupo, com o foco pelo resumo.
      await page.getByRole('button', { name: 'Calcular a cotação' }).click();
      await expect(page.getByRole('alert').first()).toContainText('Escolha onde o ambiente roda');
      await audit(page, testInfo, `cliente-no-cliente-sem-escolha-${theme}`);
      await page.getByRole('radio', { name: 'Infraestrutura do cliente' }).check();
      await page.getByRole('button', { name: 'Calcular a cotação' }).click();
      await expect(page.getByRole('region', { name: 'Cotação de referência' })).toContainText(
        'Licença na infraestrutura do cliente',
      );
      await page.getByRole('button', { name: 'Revisar e confirmar…' }).click();
      await page.getByLabel(/Digite o subdomínio/).fill('cliente-demo-h');
      await expect(page.getByRole('button', { name: 'Criar o cliente' })).toBeEnabled();
      await audit(page, testInfo, `cliente-no-cliente-novo-${theme}`);
      await page.getByRole('button', { name: 'Criar o cliente' }).click();
      const installation = page.getByRole('region', { name: 'Instalação na infraestrutura do cliente' });
      await expect(installation).toContainText('node-v1.2.3');
      await expect(installation.getByRole('link', { name: /Guia de instalação/ })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Provisionamento' })).toHaveCount(0);
      await audit(page, testInfo, `cliente-no-cliente-criado-${theme}`);

      // O fictício esperando a instalação: só cancelar, com o texto do que não acontece no cliente.
      await page.goto('/clientes/01JC0000000000000000000E01');
      const lifecycle = page.getByRole('region', { name: 'Ciclo de vida' });
      await expect(lifecycle).toContainText('quem apaga o ambiente é o próprio cliente');
      await lifecycle.getByRole('button', { name: 'Cancelar contrato…' }).click();
      await expect(lifecycle).toContainText('Só registra o fim do contrato');
      await audit(page, testInfo, `cliente-no-cliente-detalhe-${theme}`);
      expect(violations).toEqual([]);
    });

    test('acesso: a entrada sem sessão, com o erro genérico, e a entrada com o código', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme, createFakeState({ loggedIn: false }));
      await page.goto('/clientes');
      await expect(page.getByRole('heading', { name: 'Entrar no console' })).toBeVisible();
      await page.getByLabel('E-mail').fill(FICTITIOUS_OWNER);
      await page.getByLabel('Senha').fill('senha-errada-errada');
      await page.getByLabel('Código do aplicativo').fill(FICTITIOUS_TOTP_CODE);
      await page.getByRole('button', { name: 'Entrar' }).click();
      // A mesma mensagem genérica da API (`LOGIN_FAILED_MESSAGE` do cp-admin), seja qual for o erro.
      await expect(page.getByRole('alert')).toContainText(LOGIN_FAILED_MESSAGE);
      await audit(page, testInfo, `entrada-${theme}`);
      await page.getByLabel('Senha').fill(FICTITIOUS_LOGIN_PHRASE);
      await page.getByLabel('Código do aplicativo').fill(FICTITIOUS_TOTP_CODE);
      await page.getByRole('button', { name: 'Entrar' }).click();
      await expect(page).toHaveURL(/\/clientes$/);
      await expect(page.getByTestId('usuario')).toHaveText(FICTITIOUS_OWNER);
      expect(violations).toEqual([]);
    });

    test('primeiro acesso: o QR gerado no navegador e os códigos de recuperação', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme, createFakeState({ loggedIn: false, setupOpen: true }));
      await page.goto('/configurar');
      await page.getByLabel('Token de configuração').fill(FICTITIOUS_SETUP_TOKEN);
      await page.getByLabel('E-mail').fill(FICTITIOUS_OWNER);
      await page.getByLabel('Senha nova', { exact: true }).fill(FICTITIOUS_LOGIN_PHRASE);
      await page.getByLabel('Confirme a senha nova').fill(FICTITIOUS_LOGIN_PHRASE);
      await page.getByRole('button', { name: 'Continuar' }).click();
      await expect(page.getByRole('img', { name: /QR para cadastrar/ })).toBeVisible();
      await audit(page, testInfo, `configurar-qr-${theme}`);
      await page.getByLabel('Código do aplicativo').fill(FICTITIOUS_TOTP_CODE);
      await page.getByRole('button', { name: 'Confirmar o aplicativo' }).click();
      await expect(page.getByRole('list', { name: 'Códigos de recuperação' })).toBeVisible();
      await audit(page, testInfo, `configurar-codigos-${theme}`);
      expect(violations).toEqual([]);
    });

    test('simulador: a DRE do mês com as margens, a implantação e os doze meses', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/simulador');
      await expect(page.getByLabel('Contas de nuvem')).toHaveValue('2');
      await page.getByLabel('Pacote de partida').selectOption({ label: 'Com agentes (teste)' });
      await page.getByLabel('Desconto nos itens mensais (%)').fill('20');
      await page.getByRole('button', { name: 'Simular' }).click();
      const dre = page.getByRole('region', { name: 'DRE por cliente e por mês' });
      await expect(dre).toContainText('Abaixo do alerta (35,0%)');
      await audit(page, testInfo, `simulador-${theme}`);
      expect(violations).toEqual([]);
    });
  });
}

test('teclado: o primeiro Tab leva ao "Pular para o conteúdo", e ele leva ao conteúdo', async ({ page }) => {
  await mockAdminApi(page);
  await page.goto('/simulador');
  await expect(page.getByLabel('Contas de nuvem')).toHaveValue('2');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#conteudo')).toBeFocused();
});
