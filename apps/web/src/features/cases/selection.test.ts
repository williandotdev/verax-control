import { describe, expect, it } from 'vitest';
import { freshest, pageCheck, rangeOf, setSelected } from './selection';

const row = (id: string, version = 1) => ({ id, version });
const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => row(id));
const none = new Map<string, ReturnType<typeof row>>();
const ids = (selected: ReadonlyMap<string, unknown>) => [...selected.keys()];

describe('seleção de linhas', () => {
  it('marca e desmarca, na ordem em que foram marcadas, sem mexer no mapa de antes', () => {
    const first = setSelected(none, [row('b'), row('a')], true, 10);
    expect(ids(first.selected)).toEqual(['b', 'a']);
    expect(first.refused).toBe(0);
    expect(none.size).toBe(0);
    const second = setSelected(first.selected, [row('b')], false, 10);
    expect(ids(second.selected)).toEqual(['a']);
    expect(ids(first.selected)).toEqual(['b', 'a']);
  });

  it('para no teto e diz quantas ficaram de fora; a que já estava marcada não conta de novo', () => {
    const full = setSelected(none, rows.slice(0, 3), true, 3);
    expect(full.refused).toBe(0);
    const over = setSelected(full.selected, rows, true, 3);
    expect(ids(over.selected)).toEqual(['a', 'b', 'c']);
    expect(over.refused).toBe(2);
    expect(setSelected(full.selected, [row('c')], true, 3).refused).toBe(0);
  });

  it('desmarcar nunca é barrado pelo teto', () => {
    const full = setSelected(none, rows.slice(0, 3), true, 3);
    expect(ids(setSelected(full.selected, rows, false, 3).selected)).toEqual([]);
  });

  it('marcar de novo guarda a linha mais nova', () => {
    const first = setSelected(none, [row('a', 1)], true, 2);
    expect(setSelected(first.selected, [row('a', 2)], true, 2).selected.get('a')?.version).toBe(2);
  });

  it.each([
    ['b', 'd', ['b', 'c', 'd']],
    ['d', 'b', ['b', 'c', 'd']],
    ['c', 'c', ['c']],
    [null, 'd', ['d']],
    ['fora', 'd', ['d']],
    ['a', 'fora', []],
  ])('o trecho de %s a %s (Shift)', (anchor, id, expected) => {
    expect(rangeOf(rows, anchor, id).map((entry) => entry.id)).toEqual(expected);
  });

  it('a caixa do cabeçalho é só desta página: nada, algumas ou todas', () => {
    expect(pageCheck(none, rows)).toBe('none');
    expect(pageCheck(setSelected(none, [row('a')], true, 9).selected, rows)).toBe('some');
    expect(pageCheck(setSelected(none, rows, true, 9).selected, rows)).toBe('all');
    // Marcadas em outra página não marcam a caixa desta.
    expect(pageCheck(setSelected(none, [row('z')], true, 9).selected, rows)).toBe('none');
    expect(pageCheck(setSelected(none, rows, true, 9).selected, [])).toBe('none');
  });

  it('as contas usam a linha de agora para o que está na tela, e a guardada para o resto', () => {
    const selected = setSelected(none, [row('a', 1), row('z', 1)], true, 9).selected;
    expect(freshest(selected, [row('a', 5)])).toEqual([row('a', 5), row('z', 1)]);
  });
});
