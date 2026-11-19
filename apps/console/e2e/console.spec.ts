import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { createFakeState, type FakeAdminState } from '../src/mocks/fake-admin-api';
import { FICTITIOUS_LOGIN_PHRASE, FICTITIOUS_TOTP_CODE, LOGIN_FAILED_MESSAGE } from '../src/mocks/fake-auth';
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
      await page.getByLabel('Serviço mensal (R$)').fill('1,00');
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
      await expect(page.getByLabel('Volume de logs (GB/dia)')).toHaveValue('3');
      await page.getByLabel('Razão social').fill('Cliente Demo D Ltda');
      await page.getByLabel('CNPJ').fill('11.222.333/0001-81');
      await page.getByLabel('E-mail do administrador do cliente').fill('admin@cliente-demo-d.example');
      await page.getByLabel('Subdomínio').fill('cliente-demo-d');
      await page.getByRole('radio', { name: 'Infraestrutura da Verax' }).check();
      await page.getByRole('button', { name: 'Calcular a cotação' }).click();
      await expect(page.getByRole('region', { name: 'Cotação de referência' })).toContainText('R$ 1.500,00');
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

    test('aditivo do contrato: no cliente antes da instalação, para a Verax e o vCISO, com o que muda e o histórico', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/clientes/01JC0000000000000000000E01');
      const contracted = page.getByRole('region', { name: 'Contratado' });
      await contracted.getByRole('button', { name: 'Alterar contrato…' }).click();
      const form = page.getByRole('region', { name: 'Alterar contrato (aditivo)' });
      await form.getByRole('radio', { name: 'Infraestrutura da Verax' }).check();
      await form.getByLabel('Plano').selectOption('vciso');
      await form.getByLabel('Volume de logs (GB/dia)').fill('4');
      await form.getByRole('button', { name: 'Calcular a cotação' }).click();
      await expect(form.getByRole('region', { name: 'Cotação de referência' })).toContainText('R$ 4.000,00');
      await expect(form.getByLabel('Implantação do SIEM + vCISO (uma vez)')).toHaveValue('5.000,00');
      await form.getByLabel('Implantação do SIEM + vCISO (uma vez)').fill('0');
      await form.getByRole('button', { name: 'Revisar e confirmar…' }).click();
      const diff = form.getByRole('table', { name: 'O que muda no contrato' });
      await expect(diff.getByRole('row', { name: /Onde o ambiente roda/ })).toContainText('muda');
      await form.getByLabel(/Digite o subdomínio/).fill('cliente-demo-e');
      await expect(form.getByRole('button', { name: 'Gravar o aditivo' })).toBeEnabled();
      await audit(page, testInfo, `cliente-aditivo-${theme}`);
      await form.getByRole('button', { name: 'Gravar o aditivo' }).click();
      await expect(contracted.getByRole('status')).toContainText('Iniciar provisionamento');
      await expect(page.getByRole('list', { name: /Aditivos do contrato/ })).toContainText('SIEM + vCISO');
      await expect(
        page
          .getByRole('region', { name: 'Provisionamento' })
          .getByRole('button', { name: 'Iniciar provisionamento…' }),
      ).toBeVisible();
      await audit(page, testInfo, `cliente-aditivo-gravado-${theme}`);
      expect(violations).toEqual([]);
    });

    test('clientes no cliente: o cadastro do Dedicado, sem provisionar, e o detalhe com o perfil, a rede e o comando', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/clientes/novo');
      await expect(page.getByLabel('Volume de logs (GB/dia)')).toHaveValue('3');
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
        'GB/dia do servidor dedicado',
      );
      await page.getByRole('button', { name: 'Revisar e confirmar…' }).click();
      await page.getByLabel(/Digite o subdomínio/).fill('cliente-demo-h');
      await expect(page.getByRole('button', { name: 'Criar o cliente' })).toBeEnabled();
      await audit(page, testInfo, `cliente-no-cliente-novo-${theme}`);
      await page.getByRole('button', { name: 'Criar o cliente' }).click();
      const installation = page.getByRole('region', { name: 'Instalação na infraestrutura do cliente' });
      // Os três blocos: o perfil da VM, a rede (só saída) e o comando, gerado com a confirmação pelo subdomínio.
      await expect(installation.getByRole('region', { name: '1. Perfil da VM' })).toContainText('porte P');
      await expect(installation.getByRole('region', { name: '2. Rede' })).toContainText(
        'Nenhuma porta de entrada.',
      );
      const command = installation.getByRole('region', { name: '3. Comando de instalação' });
      await command.getByRole('button', { name: 'Gerar comando…' }).click();
      await command.getByLabel(/Digite o subdomínio/).fill('cliente-demo-h');
      await command.getByRole('button', { name: 'Confirmar: gerar comando' }).click();
      await expect(command.getByLabel('Comando de instalação gerado')).toContainText(
        'sudo bash verax-install.sh --codigo ',
      );
      // A versão e o guia ficam nos detalhes técnicos, recolhidos.
      await installation.getByText('Detalhes técnicos').click();
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

    test('conta: a troca do aplicativo com o QR gerado no navegador e os códigos de recuperação', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      // Não há tela de cadastro: a antiga /configurar é uma página que não existe.
      await page.goto('/configurar');
      await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
      await page.goto('/conta');
      const form = page.getByRole('form', { name: 'Trocar o aplicativo autenticador' });
      await form.getByLabel('Senha atual').fill(FICTITIOUS_LOGIN_PHRASE);
      await form.getByLabel('Código do aplicativo atual').fill(FICTITIOUS_TOTP_CODE);
      await form.getByRole('button', { name: 'Trocar o aplicativo' }).click();
      await expect(page.getByRole('img', { name: /QR para cadastrar/ })).toBeVisible();
      await audit(page, testInfo, `conta-qr-${theme}`);
      const card = page.getByRole('region', { name: 'Trocar o aplicativo autenticador' });
      await card.getByLabel('Código do aplicativo').fill(FICTITIOUS_TOTP_CODE);
      await card.getByRole('button', { name: 'Confirmar o aplicativo novo' }).click();
      await expect(page.getByRole('list', { name: 'Códigos de recuperação' })).toBeVisible();
      await audit(page, testInfo, `conta-codigos-${theme}`);
      expect(violations).toEqual([]);
    });

    test('textos legais: a lista com o aviso, o rascunho com a prévia e a publicação com a versão digitada', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/textos-legais');
      await expect(page.getByRole('region', { name: 'Acordo de tratamento de dados (DPA)' })).toContainText(
        'Nenhuma versão publicada',
      );
      await audit(page, testInfo, `textos-legais-${theme}`);

      await page.getByRole('link', { name: '2026-11-10' }).click();
      await page.getByLabel('Texto (Markdown)').fill('# Termos revisados\n\n- item com **negrito**\n');
      await expect(page.getByRole('region', { name: 'Prévia' }).getByRole('heading')).toHaveText(
        'Termos revisados',
      );
      await page.getByRole('button', { name: 'Salvar rascunho' }).click();
      await expect(page.getByText('Rascunho salvo.')).toBeVisible();
      await page.getByRole('button', { name: 'Publicar…' }).click();
      await page.getByLabel(/Digite a versão/).fill('2026-11-10');
      await expect(page.getByRole('button', { name: 'Confirmar a publicação' })).toBeEnabled();
      await audit(page, testInfo, `texto-legal-publicar-${theme}`);
      await page.getByRole('button', { name: 'Confirmar a publicação' }).click();
      await expect(page.getByText(/Publicada: 2026-11-10, em/)).toBeVisible();
      await audit(page, testInfo, `texto-legal-publicado-${theme}`);
      expect(violations).toEqual([]);
    });

    test('simulador: a DRE do mês com as margens, a implantação e os doze meses', async ({
      page,
    }, testInfo) => {
      const violations = await prepare(page, theme);
      await page.goto('/simulador');
      await expect(page.getByLabel('Volume de logs (GB/dia)')).toHaveValue('2');
      await page.getByLabel('Plano').selectOption({ label: 'SIEM + vCISO' });
      await page.getByLabel('Desconto nos itens mensais (%)').fill('35');
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
  await expect(page.getByLabel('Volume de logs (GB/dia)')).toHaveValue('2');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#conteudo')).toBeFocused();
});
