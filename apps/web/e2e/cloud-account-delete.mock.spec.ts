import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * "Excluir conta" no detalhe da conta cloud, no navegador, sobre a demonstração (`dev:mock`): a zona de perigo, a
 * confirmação com o ID digitado e o aviso depois da exclusão, sem violação de acessibilidade (WCAG 2.2 AA, inclusive
 * contraste) em cada passo, nos dois temas, pelo teclado.
 */

/** A conta AWS de homologação da demonstração (`account(2, ...)` em mocks/admin.ts). */
const AWS_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0002';
const AWS_ID = '444455556666';
const AWS_DIALOG = `Conta AWS ${AWS_ID}`;

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

async function useRole(page: Page, role: string, theme: 'light' | 'dark' = 'light') {
  await page.addInitScript(
    ([mockRole, value]) => {
      window.localStorage.setItem('verax.mock.role', mockRole);
      window.localStorage.setItem('verax.theme', value);
    },
    [role, theme] as const,
  );
  await skipDemoTour(page);
}

test.describe('excluir a conta cloud (modo mock)', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`AWS (${theme === 'light' ? 'claro' : 'escuro'}): a confirmação pelo teclado, a exclusão e o aviso, sem violação de acessibilidade`, async ({
      page,
    }) => {
      // Três análises de acessibilidade sobre o detalhe da conta AWS (com as fontes): com os outros testes em paralelo,
      // passam dos 30 s padrão sem nada de errado.
      test.setTimeout(90_000);
      await useRole(page, 'admin_cliente', theme);
      await page.goto(`/cadastros/contas?conta=${AWS_ACCOUNT}`);
      const sheet = page.getByRole('dialog', { name: AWS_DIALOG });
      const zone = sheet.getByRole('region', { name: 'Excluir conta' });
      await expect(zone.getByRole('button', { name: 'Excluir conta…' })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);

      // Pelo teclado: abrir a confirmação põe o foco no campo do ID; o botão só libera com o ID certo.
      await zone.getByRole('button', { name: 'Excluir conta…' }).focus();
      await page.keyboard.press('Enter');
      const confirmation = zone.getByRole('group', { name: `Confirmar a exclusão de ${AWS_ID}` });
      const field = confirmation.getByLabel(`Digite o ID da conta (${AWS_ID}) para confirmar`);
      await expect(field).toBeFocused();
      await expect(confirmation).toContainText('a pilha verax-control-reader continua na conta');
      const confirm = confirmation.getByRole('button', { name: 'Excluir definitivamente' });
      await page.keyboard.type('111122223333');
      await expect(confirm).toBeDisabled();
      expect(await violations(page)).toEqual([]);

      await field.fill(AWS_ID);
      await expect(field).toHaveAccessibleDescription('Confere.');
      await expect(confirm).toBeEnabled();
      await confirm.focus();
      await page.keyboard.press('Enter');

      // O painel fecha, a linha sai da tabela e o aviso recebe o foco.
      await expect(sheet).toBeHidden();
      const notice = page.getByRole('status').filter({ hasText: `Conta AWS ${AWS_ID} excluída.` });
      await expect(notice).toBeFocused();
      const table = page.getByRole('table', { name: 'Contas cloud do cliente' });
      await expect(table).not.toContainText(AWS_ID);
      await expect(table).toContainText('111122223333');
      expect(await violations(page)).toEqual([]);

      // O mesmo ID pode ser cadastrado de novo.
      await page.getByRole('button', { name: 'Cadastrar conta' }).click();
      const create = page.getByRole('dialog', { name: 'Cadastrar conta' });
      await create.getByLabel('ID da conta AWS').fill(AWS_ID);
      await create.getByRole('button', { name: 'Cadastrar conta' }).click();
      await expect(create.getByText(new RegExp(`Conta AWS ${AWS_ID} cadastrada`))).toBeVisible();
    });
  }
});
