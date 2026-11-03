import { z } from 'zod';

/** Chave própria do tour no `localStorage` (só existe na demonstração). */
export const TOUR_STORAGE_KEY = 'verax.demo-tour';

const progressSchema = z.object({
  /** Já viu: pulou ou concluiu. O tour não abre mais sozinho. */
  seen: z.boolean().default(false),
  /** Aberto agora: recarregar a página ou sair e voltar ao painel continua o tour. */
  open: z.boolean().default(false),
  /** Passo atual (aberto) ou onde parou (pulado); `null` depois de concluir. */
  step: z.string().nullable().default(null),
});

export type TourProgress = z.infer<typeof progressSchema>;

export const EMPTY_PROGRESS: TourProgress = { seen: false, open: false, step: null };

/**
 * Progresso guardado no navegador. Valor estranho ou armazenamento indisponível (modo privado, cota) valem como
 * "nunca viu": o tour funciona sem guardar nada, mas não trava.
 */
export function readTourProgress(): TourProgress {
  try {
    const raw = window.localStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return EMPTY_PROGRESS;
    const parsed = progressSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_PROGRESS;
  } catch {
    return EMPTY_PROGRESS;
  }
}

export function writeTourProgress(progress: TourProgress): void {
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Sem armazenamento, o tour segue só na memória.
  }
}
