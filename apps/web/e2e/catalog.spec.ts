import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * Catálogo do design system: sem violações de acessibilidade (WCAG 2.2 AA, axe) nos dois temas, e uma captura
 * de tela de cada tema para inspeção visual.
 */
for (const theme of ['light', 'dark'] as const) {
  test(`catálogo no tema ${theme}: acessível e renderizado`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
    await page.goto('/catalogo');
    await expect(page.getByRole('heading', { name: 'Catálogo do design system' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('meter')).toHaveCount(3);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);

    await page.screenshot({ path: testInfo.outputPath(`catalogo-${theme}.png`), fullPage: true });
  });
}
