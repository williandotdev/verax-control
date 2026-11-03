import type { Page } from '@playwright/test';

/** Progresso do tour guiado da demonstração (chave e formato em `src/features/tour/progress.ts`). */
export interface TourProgress {
  seen: boolean;
  open: boolean;
  step: string | null;
}

export const TOUR_STORAGE_KEY = 'verax.demo-tour';

/** Grava o progresso do tour antes de a página carregar. */
export async function setTourProgress(page: Page, progress: TourProgress): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    TOUR_STORAGE_KEY,
    JSON.stringify(progress),
  ] as const);
}

/** O tour abre sozinho na primeira entrada no painel: os testes das telas entram como quem já o viu. */
export async function skipDemoTour(page: Page): Promise<void> {
  await setTourProgress(page, { seen: true, open: false, step: null });
}
