import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PROGRESS, readTourProgress, TOUR_STORAGE_KEY, writeTourProgress } from './progress';

describe('progresso do tour no localStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sem nada guardado: nunca viu', () => {
    expect(readTourProgress()).toEqual(EMPTY_PROGRESS);
  });

  it('guarda e lê o passo e o "já vi", na chave própria', () => {
    writeTourProgress({ seen: true, open: false, step: 'achados' });
    expect(JSON.parse(window.localStorage.getItem(TOUR_STORAGE_KEY) ?? '')).toEqual({
      seen: true,
      open: false,
      step: 'achados',
    });
    expect(readTourProgress()).toEqual({ seen: true, open: false, step: 'achados' });
  });

  it('completa o que faltar e descarta valor estranho', () => {
    window.localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify({ seen: true }));
    expect(readTourProgress()).toEqual({ seen: true, open: false, step: null });
    window.localStorage.setItem(TOUR_STORAGE_KEY, '{quebrado');
    expect(readTourProgress()).toEqual(EMPTY_PROGRESS);
    window.localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify({ seen: 'sim', step: 3 }));
    expect(readTourProgress()).toEqual(EMPTY_PROGRESS);
  });

  it('armazenamento indisponível não derruba o tour', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('indisponível');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cota');
    });
    expect(readTourProgress()).toEqual(EMPTY_PROGRESS);
    expect(() => writeTourProgress({ seen: true, open: false, step: null })).not.toThrow();
  });
});
