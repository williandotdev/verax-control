import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Revisão de UX (T7.12) no navegador, sobre a demonstração (`dev:mock`): toda tela sem violação de acessibilidade
 * (WCAG 2.2 AA, inclusive contraste), sem rolagem horizontal da página no celular (as tabelas rolam por dentro) e
 * com o fluxo de teclado do painel de detalhe.
 */

const INCIDENT = '018f2c1e-0000-7000-8000-0000000a0001';
const FINDING = '018f2c1e-0000-7000-8000-000000001001';
const AUDIT_ENTRY = '018f2c1e-0000-7000-8000-0000000d0002';

const PAGES: [string, string | RegExp][] = [
  ['/', 'Torre'],
  ['/incidentes', 'Incidentes'],
  [`/incidentes/${INCIDENT}`, /Atividade suspeita com a chave de acesso/],
  ['/achados', 'Achados'],
  ['/postura', 'Postura cloud'],
  ['/ativos', 'Ativos e identidades'],
  ['/ativos?aba=security-groups', 'Ativos e identidades'],
  ['/relatorios', 'Relatórios'],
  ['/relatorios?aba=mitre', 'Relatórios'],
  ['/relatorios?aba=incidentes&periodo=90d', 'Relatórios'],
  ['/cadastros/clientes', 'Clientes'],
  ['/cadastros/usuarios', 'Usuários'],
  ['/cadastros/contas', 'Contas cloud'],
  ['/cadastros/protecao', 'Lista de proteção'],
  ['/cadastros/excecoes', 'Exceções'],
  ['/auditoria', 'Auditoria'],
  ['/alertas-sem-dono', 'Alertas sem dono'],
];

async function open(page: Page, path: string, heading: string | RegExp) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  // Nada carregando: a análise vê a tela pronta.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('revisão de UX (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'admin_verax'));
  });

  // Nos dois temas: o contraste do escuro não é o do claro invertido (tokens escolhidos à mão em cada modo).
  for (const theme of ['light', 'dark'] as const) {
    for (const [path, heading] of PAGES) {
      test(`${path} (${theme === 'light' ? 'claro' : 'escuro'}): sem violação de acessibilidade`, async ({
        page,
      }) => {
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await open(page, path, heading);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await violations(page)).toEqual([]);
      });
    }
  }

  // Um teste por painel: cada análise de acessibilidade leva alguns segundos, e juntos passavam do tempo de um teste.
  // Abertos pela URL: com o painel modal, o resto da página fica fora da árvore de acessibilidade.
  for (const [path, dialog] of [
    [`/achados?achado=${FINDING}`, 'Tentativa de desligar a trilha do CloudTrail'],
    [`/auditoria?registro=${AUDIT_ENTRY}`, 'Comentou achado'],
  ] as const) {
    test(`painel de detalhe ${path}: sem violação de acessibilidade`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('dialog', { name: dialog })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('painel de detalhe da postura: sem violação de acessibilidade', async ({ page }) => {
    await open(page, '/postura?severidade=critical', 'Postura cloud');
    await page.getByRole('button', { name: /Usuário root sem MFA/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  // A troca da senha temporária só abre para a sessão de primeiro acesso: entra pela senha temporária da demonstração.
  test('/trocar-senha (primeiro acesso): sem violação de acessibilidade', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill('analista@demo.verax.local');
    await page.getByLabel('Senha', { exact: true }).fill('senha-temporaria-demonstracao');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL(/\/trocar-senha$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Troque a senha temporária' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('senha temporária de uma conta nova: sem violação de acessibilidade', async ({ page }) => {
    await open(page, '/cadastros/usuarios', 'Usuários');
    await page.getByRole('button', { name: 'Criar usuário' }).click();
    const sheet = page.getByRole('dialog', { name: 'Criar usuário' });
    await sheet.getByLabel('Nome').fill('Bruna Melo');
    await sheet.getByLabel('E-mail').fill('bruna@exemplo.com.br');
    await sheet.getByRole('button', { name: 'Criar usuário' }).click();
    await expect(sheet.getByRole('region', { name: 'Senha temporária de Bruna Melo' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('teclado: o detalhe abre com Enter, fecha com Esc e o foco volta para o achado', async ({ page }) => {
    await open(page, '/achados?severidade=critical', 'Achados');
    const finding = page.getByRole('button', { name: /Tentativa de desligar a trilha/ });
    await finding.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // O foco fica preso no painel.
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(finding).toBeFocused();
  });

  test('celular: nenhuma tela rola na horizontal', async ({ page }) => {
    // Percorre todas as telas num teste só: o tempo cresce com a lista (cerca de 2 s por tela).
    test.setTimeout(PAGES.length * 5_000);
    await page.setViewportSize({ width: 360, height: 800 });
    const overflowing: string[] = [];
    for (const [path, heading] of PAGES) {
      await open(page, path, heading);
      // A falha diz qual elemento passa da tela (fora dos quadros que rolam por dentro): as fontes do Linux do CI
      // são mais largas que as de outras máquinas, e só o nome do elemento permite corrigir sem adivinhar.
      const problem = await page.evaluate(() => {
        const extra = document.documentElement.scrollWidth - window.innerWidth;
        if (extra <= 1) return null;
        const scrollsInside = (element: Element) => {
          for (
            let parent = element.parentElement;
            parent && parent !== document.body;
            parent = parent.parentElement
          ) {
            if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX))
              return true;
          }
          return false;
        };
        const culprits = Array.from(document.body.querySelectorAll('*'))
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
          .filter((element) => !scrollsInside(element))
          .slice(-3)
          .map(
            (element) => `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}">`,
          );
        return `${extra}px (${culprits.join(', ')})`;
      });
      if (problem) overflowing.push(`${path}: ${problem}`);
    }
    expect(overflowing).toEqual([]);
  });
});
