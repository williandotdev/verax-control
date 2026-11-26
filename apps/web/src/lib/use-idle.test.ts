import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdle } from './use-idle';

describe('useIdle (E-14)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fica parado depois do prazo sem movimento, e volta no primeiro movimento', () => {
    const { result } = renderHook(() => useIdle(60_000));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('pointermove'));
    });
    expect(result.current).toBe(false);
    // O movimento recomeça a contagem.
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(result.current).toBe(false);
  });

  it('para de ouvir ao sair da tela', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useIdle(1_000));
    unmount();
    expect(remove.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining(['pointermove', 'keydown', 'scroll']),
    );
  });
});
