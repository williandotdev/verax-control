import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetOriginPlace, readOriginPlace, rememberOriginPlace } from './origin-place';

const KEY = 'verax:deteccoes:origens:lugar:pessoa-a:cliente-a';
const read = () => readOriginPlace('pessoa-a', 'cliente-a');
const remember = (height?: number, header = 80) =>
  rememberOriginPlace('pessoa-a', 'cliente-a', height === undefined ? undefined : { height, header });
const NONE = { height: null, header: null };

function innerWidth(value: number) {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(value);
}

beforeEach(() => {
  window.localStorage.clear();
  innerWidth(1280);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('o lugar da faixa do mapa de origens', () => {
  it('nunca vista, não há lugar; vista recolhida, há sem altura; aberta, com a altura (para cima, em px inteiros)', () => {
    expect(read()).toBeNull();
    remember();
    expect(read()).toEqual(NONE);
    remember(611.2, 79.5);
    expect(window.localStorage.getItem(KEY)).toBe('1280x612x80');
    expect(read()).toEqual({ height: 612, header: 80 });
    // Saber de novo que ela existe não apaga a altura.
    remember();
    expect(read()).toEqual({ height: 612, header: 80 });
  });

  it('com outra largura de janela, a altura não vale', () => {
    remember(612);
    innerWidth(1440);
    expect(read()).toEqual(NONE);
  });

  it('é por pessoa e por cliente, e some quando a faixa some', () => {
    remember(612);
    expect(readOriginPlace('pessoa-b', 'cliente-a')).toBeNull();
    expect(readOriginPlace('pessoa-a', 'cliente-b')).toBeNull();
    forgetOriginPlace('pessoa-a', 'cliente-b');
    expect(read()).toEqual({ height: 612, header: 80 });
    forgetOriginPlace('pessoa-a', 'cliente-a');
    expect(read()).toBeNull();
  });

  it('o que não é um tamanho não vira altura', () => {
    for (const stored of [
      '',
      'sim',
      '1280',
      '1280x',
      '1280x600',
      '1280x600x',
      '1280x0x80',
      '1280x600x0',
      '1280x-5x80',
      '1280x6.5x80',
      '1280x600x6.5',
      '1280x4001x80',
      '1280x600x4001',
      '1280xInfinityx80',
      '1280x600x80x1',
      'axbxc',
    ]) {
      window.localStorage.setItem(KEY, stored);
      expect(read(), stored).toEqual(NONE);
    }
    window.localStorage.setItem(KEY, '1280x4000x4000');
    expect(read()).toEqual({ height: 4_000, header: 4_000 });
  });

  it('sem armazenamento, nada é guardado e nada quebra', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('bloqueado');
      });
    }
    expect(() => {
      remember();
      remember(10);
      forgetOriginPlace('pessoa-a', 'cliente-a');
    }).not.toThrow();
    expect(read()).toBeNull();
  });
});
