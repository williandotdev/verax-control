import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Os buckets cadastrados à mão da conta AWS ("Avançado: buckets fora do padrão") no navegador, sobre a demonstração
 * (`dev:mock`): o campo do cadastro e da alteração sem violação de acessibilidade (WCAG 2.2 AA, inclusive contraste) em
 * cada passo, nos dois temas, com o teclado (remover devolve o foco para "Adicionar bucket", adicionar põe o foco no
 * nome da linha nova, o erro leva o foco ao campo) e o aviso de atualizar a pilha depois de salvar outra lista.
 */

/** A conta AWS conectada da demonstração (`account(1, ...)` em mocks/admin.ts), com a trilha, o GuardDuty e o WAF. */
const AWS_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0001';
const AWS_DIALOG = 'Conta AWS 111122223333';

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

test.describe('buckets fora do padrão da conta AWS (modo mock)', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`alteração (${theme === 'light' ? 'claro' : 'escuro'}): remover, adicionar pelo teclado, o erro no campo e o aviso da pilha, sem violação de acessibilidade`, async ({
      page,
    }) => {
      // Cinco análises de acessibilidade sobre o detalhe da conta, que agora traz as fontes e os grupos de logs: com os
      // outros testes em paralelo, passam dos 30 s padrão sem nada de errado.
      test.setTimeout(90_000);
      await useRole(page, 'admin_verax', theme);
      // A conta já conectada abre em abas (E-04): os buckets ficam em "Avançado", e a pilha, em "Conexão e pilha".
      await page.goto(`/cadastros/contas?conta=${AWS_ACCOUNT}&aba=avancado`);
      const sheet = page.getByRole('dialog', { name: AWS_DIALOG });
      // A conta tem buckets cadastrados: o "Avançado: buckets fora do padrão" abre sozinho.
      const section = sheet.getByRole('region', { name: 'Buckets fora do padrão' });
      const stack = sheet.getByRole('region', { name: 'Pilha na AWS' });
      await expect(section.getByRole('group', { name: 'Bucket 3' })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);

      // Pelo teclado: remover o WAF devolve o foco para "Adicionar bucket"; Enter cria a linha com a fonte livre.
      await section.getByRole('button', { name: 'Remover o bucket 3 (WAF)' }).focus();
      await page.keyboard.press('Enter');
      const add = section.getByRole('button', { name: 'Adicionar bucket' });
      await expect(add).toBeFocused();
      await page.keyboard.press('Enter');
      const row = section.getByRole('group', { name: 'Bucket 3' });
      const name = row.getByLabel('Nome do bucket');
      await expect(name).toBeFocused();
      await expect(row.getByLabel('Fonte')).toHaveValue('waf');
      expect(await violations(page)).toEqual([]);

      // Fora da regra da AWS: o erro fica no campo, que recebe o foco.
      await page.keyboard.type('logs-do-waf');
      await section.getByRole('button', { name: 'Salvar buckets' }).click();
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      await expect(name).toHaveAccessibleDescription(/O bucket do WAF começa com aws-waf-logs-/);
      await expect(name).toBeFocused();
      expect(await violations(page)).toEqual([]);

      // O ARN colado vira o nome; a lista nova pede a pilha atualizada e o Verificar, e a conexão volta a aguardar.
      await name.fill('arn:aws:s3:::aws-waf-logs-loja-alfa-nova');
      await section.getByRole('button', { name: 'Salvar buckets' }).click();
      await expect(section.getByRole('status')).toContainText('Buckets salvos, e a lista mudou.');
      await expect(name).toHaveValue('aws-waf-logs-loja-alfa-nova');
      // A lista nova já está nos passos da pilha (o comando da CLI fica recolhido).
      await sheet.getByRole('tab', { name: 'Conexão e pilha' }).click();
      await expect(stack.getByRole('listitem').filter({ hasText: '(LogBucketArns)' }).last()).toContainText(
        'arn:aws:s3:::aws-waf-logs-loja-alfa-nova',
      );
      await expect(
        sheet.getByRole('tabpanel').getByText('Aguardando uma nova verificação', { exact: false }),
      ).toBeVisible();
      // O caminho de volta (verificar a conexão) fica no topo da visão geral.
      await sheet.getByRole('tab', { name: 'Visão geral' }).click();
      await expect(
        sheet
          .getByRole('region', { name: 'Reconectar a conta 111122223333' })
          .getByRole('button', { name: 'Verificar conexão' }),
      ).toBeEnabled();
      expect(await violations(page)).toEqual([]);
    });
  }

  test('cadastro: a linha sem nome com o erro e a conta cadastrada com os buckets, sem violação de acessibilidade', async ({
    page,
  }) => {
    await useRole(page, 'admin_verax');
    await page.goto('/cadastros/contas');
    await page.getByRole('button', { name: 'Cadastrar conta' }).click();
    const sheet = page.getByRole('dialog', { name: 'Cadastrar conta' });
    // No cadastro, os buckets ficam recolhidos: só para os logs fora do padrão AWSLogs.
    await sheet.getByText('Avançado: buckets fora do padrão').click();
    const buckets = sheet.getByRole('group', { name: 'Buckets fora do padrão (opcional)' });
    await sheet.getByLabel('ID da conta AWS').fill('135792468024');
    await buckets.getByRole('button', { name: 'Adicionar bucket' }).click();
    const name = buckets.getByRole('group', { name: 'Bucket 1' }).getByLabel('Nome do bucket');
    await expect(name).toBeFocused();
    await sheet.getByRole('button', { name: 'Cadastrar conta' }).click();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(/Informe o nome do bucket, ou remova esta linha\./);
    expect(await violations(page)).toEqual([]);

    await name.fill('exemplo-cloudtrail-logs');
    await sheet.getByRole('button', { name: 'Cadastrar conta' }).click();
    await expect(sheet.getByText(/Conta AWS 135792468024 cadastrada/)).toBeVisible();
    // O bucket cadastrado vai para o LogBucketArns da pilha: aparece na alternativa manual do "Conectar com AWS".
    const connect = sheet.getByRole('region', { name: 'Conectar a conta 135792468024' });
    await expect(connect.getByRole('button', { name: 'Conectar com AWS' })).toBeEnabled();
    await connect.getByText('Alternativa manual (sem o arquivo preenchido)').click();
    await expect(connect.getByText('arn:aws:s3:::exemplo-cloudtrail-logs', { exact: true })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('quem só lê vê os buckets, sem o formulário e sem violação de acessibilidade', async ({ page }) => {
    await useRole(page, 'leitura');
    await page.goto(`/cadastros/contas?conta=${AWS_ACCOUNT}&aba=avancado`);
    const section = page
      .getByRole('dialog', { name: AWS_DIALOG })
      .getByRole('region', { name: 'Buckets fora do padrão' });
    await expect(section.getByText('aws-waf-logs-loja-alfa')).toBeVisible();
    await expect(section.getByRole('button')).toHaveCount(0);
    await expect(section.getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });
});
