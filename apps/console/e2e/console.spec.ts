import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { mockAdminApi } from './mock-api';

/**
 * As três telas do console no navegador, nos dois temas: sem violação do axe (WCAG 2.2 AA), sem violação da CSP do
 * cp-admin e navegáveis pelo teclado. As capturas (com a tabela e o modelo FICTÍCIOS) vão para `CONSOLE_SCREENSHOTS`,
 * quando definida, ou para a pasta do teste.
 */
const THEMES = ['light', 'dark'] as const;

async function prepare(page: Page, theme: (typeof THEMES)[number]): Promise<string[]> {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) violations.push(message.text());
  });
  page.on('pageerror', (error) => violations.push(error.message));
  await page.addInitScript((value) => window.localStorage.setItem('verax.console.theme', value), theme);
  await mockAdminApi(page);
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
