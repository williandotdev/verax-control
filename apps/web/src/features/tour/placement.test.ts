import { describe, expect, it } from 'vitest';
import { EDGE, GAP, placeCard, SPOTLIGHT_PADDING, spotlightBox } from './placement';

const desktop = { width: 1280, height: 800 };
const phone = { width: 360, height: 800 };
const card = { width: 384, height: 220 };

describe('posição do cartão', () => {
  it('sem alvo, no centro da janela', () => {
    expect(placeCard(null, card, desktop)).toEqual({ top: 290, left: 448, side: 'center' });
  });

  it('embaixo do alvo, centralizado nele, quando cabe', () => {
    const target = { top: 100, left: 400, width: 200, height: 40 };
    expect(placeCard(target, card, desktop)).toEqual({ top: 140 + GAP, left: 308, side: 'below' });
  });

  it('em cima, quando embaixo não cabe', () => {
    const target = { top: 600, left: 400, width: 200, height: 40 };
    expect(placeCard(target, card, desktop)).toMatchObject({ top: 600 - GAP - 220, side: 'above' });
  });

  it('ao lado, quando nem embaixo nem em cima cabem', () => {
    const target = { top: 150, left: 300, width: 400, height: 500 };
    expect(placeCard(target, card, desktop)).toEqual({ top: 150, left: 700 + GAP, side: 'right' });
  });

  it('alvo alto (uma lista): o cartão vai para a parte de baixo da janela, não para cima', () => {
    const target = { top: 300, left: 260, width: 1000, height: 400 };
    expect(placeCard(target, card, desktop)).toEqual({ top: 800 - 220 - EDGE, left: 568, side: 'over' });
  });

  it('no celular, o cartão fica dentro da largura, com a margem', () => {
    const narrow = { width: phone.width - 2 * EDGE, height: 260 };
    for (const left of [-200, 0, 150, 340, 600]) {
      const placed = placeCard({ top: 100, left, width: 50, height: 30 }, narrow, phone);
      expect(placed.left).toBeGreaterThanOrEqual(EDGE);
      expect(placed.left + narrow.width).toBeLessThanOrEqual(phone.width - EDGE);
      expect(placed.top).toBeGreaterThanOrEqual(EDGE);
      expect(placed.top + narrow.height).toBeLessThanOrEqual(phone.height - EDGE);
    }
  });
});

describe('recorte do destaque', () => {
  it('o alvo com folga', () => {
    expect(spotlightBox({ top: 100, left: 100, width: 200, height: 50 }, desktop)).toEqual({
      top: 100 - SPOTLIGHT_PADDING,
      left: 100 - SPOTLIGHT_PADDING,
      width: 200 + 2 * SPOTLIGHT_PADDING,
      height: 50 + 2 * SPOTLIGHT_PADDING,
    });
  });

  it('cortado na janela (uma tabela mais larga que o celular)', () => {
    const box = spotlightBox({ top: 50, left: 16, width: 900, height: 2000 }, phone);
    expect(box).toMatchObject({ top: 44, left: 10 });
    expect((box?.left ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(phone.width);
    expect((box?.top ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(phone.height);
  });

  it('alvo todo fora da janela: sem recorte', () => {
    expect(spotlightBox({ top: -500, left: 10, width: 100, height: 100 }, desktop)).toBeNull();
  });
});
