import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Revisão de UX (T7.12) no navegador, sobre a demonstração (`dev:mock`): toda tela sem violação de acessibilidade
 * (WCAG 2.2 AA, inclusive contraste), sem rolagem horizontal da página no celular (as tabelas rolam por dentro) e
 * com o fluxo de teclado do painel de detalhe.
 */

const INCIDENT = '018f2c1e-0000-7000-8000-0000000a0001';
const FINDING = '018f2c1e-0000-7000-8000-000000001001';

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

  for (const [path, heading] of PAGES) {
    test(`${path}: sem violação de acessibilidade`, async ({ page }) => {
      await open(page, path, heading);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('painéis de detalhe sem violação de acessibilidade', async ({ page }) => {
    // Aberto pela URL: com o painel modal, o resto da página fica fora da árvore de acessibilidade.
    await page.goto(`/achados?achado=${FINDING}`);
    await expect(
      page.getByRole('dialog', { name: 'Tentativa de desligar a trilha do CloudTrail' }),
    ).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await open(page, '/postura?severidade=critical', 'Postura cloud');
    await page.getByRole('button', { name: /Usuário root sem MFA/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
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
