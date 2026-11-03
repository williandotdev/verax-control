/** Geometria do tour, em pixels da janela (as mesmas coordenadas de `getBoundingClientRect` e `position: fixed`). */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type CardSide = 'below' | 'above' | 'right' | 'left' | 'over' | 'center';

/** Distância mínima entre o cartão e a borda da janela. */
export const EDGE = 16;
/** Distância entre o destaque e o cartão. */
export const GAP = 12;
/** Folga do destaque em volta do alvo. */
export const SPOTLIGHT_PADDING = 6;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Um alvo mais alto que esta fração da janela (uma tabela, por exemplo) é "alto". */
const TALL = 0.4;

/**
 * Onde o cartão fica: embaixo do alvo, em cima, ao lado ou, sem espaço, sobre a parte de baixo da janela. Sem alvo,
 * no centro. Sempre dentro da janela, com a margem `EDGE` (o cartão nunca empurra a página para o lado). Sobre um
 * alvo alto, o cartão não vai para cima: cobriria o título e os filtros da tela, e o começo do alvo (o mais
 * importante de uma lista) fica à vista com o cartão embaixo.
 */
export function placeCard(
  target: Box | null,
  card: Size,
  viewport: Size,
): { top: number; left: number; side: CardSide } {
  const maxLeft = viewport.width - card.width - EDGE;
  const maxTop = viewport.height - card.height - EDGE;
  if (!target) {
    return {
      top: clamp((viewport.height - card.height) / 2, EDGE, maxTop),
      left: clamp((viewport.width - card.width) / 2, EDGE, maxLeft),
      side: 'center',
    };
  }
  const bottom = target.top + target.height;
  const right = target.left + target.width;
  const fitsVertically = (top: number) => top >= EDGE && top + card.height <= viewport.height - EDGE;
  const centeredLeft = clamp(target.left + target.width / 2 - card.width / 2, EDGE, maxLeft);

  if (fitsVertically(bottom + GAP)) return { top: bottom + GAP, left: centeredLeft, side: 'below' };
  const above = target.top - GAP - card.height;
  const tall = target.height > viewport.height * TALL;
  if (!tall && fitsVertically(above)) return { top: above, left: centeredLeft, side: 'above' };
  const sideTop = clamp(target.top, EDGE, maxTop);
  if (right + GAP + card.width <= viewport.width - EDGE) {
    return { top: sideTop, left: right + GAP, side: 'right' };
  }
  if (target.left - GAP - card.width >= EDGE) {
    return { top: sideTop, left: target.left - GAP - card.width, side: 'left' };
  }
  return { top: clamp(maxTop, EDGE, maxTop), left: centeredLeft, side: 'over' };
}

/** O recorte do destaque: o alvo com folga, cortado na janela. `null` quando o alvo está todo fora dela. */
export function spotlightBox(target: Box, viewport: Size): Box | null {
  const inset = 2;
  const top = Math.max(target.top - SPOTLIGHT_PADDING, inset);
  const left = Math.max(target.left - SPOTLIGHT_PADDING, inset);
  const bottom = Math.min(target.top + target.height + SPOTLIGHT_PADDING, viewport.height - inset);
  const right = Math.min(target.left + target.width + SPOTLIGHT_PADDING, viewport.width - inset);
  if (bottom - top < 1 || right - left < 1) return null;
  return { top, left, width: right - left, height: bottom - top };
}
