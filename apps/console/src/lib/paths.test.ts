import { describe, expect, it } from 'vitest';
import { appendAt, getAt, pathKey, removeAt, setAt } from './paths';

describe('caminhos no rascunho', () => {
  it('lê e grava por caminho sem mudar o original', () => {
    const original = { volume: { bands: [{ monthlyGib: 50 }] } };
    const next = setAt(original, ['volume', 'bands', 0, 'amount'], 10);
    expect(getAt(next, ['volume', 'bands', 0])).toEqual({ monthlyGib: 50, amount: 10 });
    expect(original.volume.bands[0]).toEqual({ monthlyGib: 50 });
    expect(pathKey(['volume', 'bands', 0, 'amount'])).toBe('volume.bands.0.amount');
  });

  it('o campo vazio sai do documento, e o objeto que fica vazio também (a raiz nunca)', () => {
    const doc = { modes: { managed: { environment: { P: { amount: 1 }, G: { amount: 2 } } } } };
    const next = setAt(doc, ['modes', 'managed', 'environment', 'G', 'amount'], undefined);
    expect(next).toEqual({ modes: { managed: { environment: { P: { amount: 1 } } } } });
    expect(setAt({ a: 1 }, ['a'], undefined)).toEqual({});
    expect(setAt({}, ['setup'], {})).toEqual({ setup: {} });
  });

  it('acrescenta e tira itens de uma lista', () => {
    const doc = appendAt(appendAt({}, ['rates'], { id: 'a' }), ['rates'], { id: 'b' });
    expect(getAt(doc, ['rates'])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(getAt(removeAt(doc, ['rates'], 0), ['rates'])).toEqual([{ id: 'b' }]);
  });

  it('só segue propriedades próprias e recusa as chaves do protótipo', () => {
    const imported = JSON.parse('{"__proto__": {"poluido": true}, "a": {"b": 1}}') as unknown;
    expect(getAt(imported, ['__proto__', 'poluido'])).toBeUndefined();
    expect(getAt(imported, ['a', 'b'])).toBe(1);
    expect(getAt({}, ['constructor'])).toBeUndefined();
    expect(getAt({ a: 1 }, ['toString'])).toBeUndefined();
    expect(() => setAt({}, ['__proto__', 'poluido'], true)).toThrow(TypeError);
    expect(() => setAt({}, ['constructor', 'prototype'], 1)).toThrow(TypeError);
    expect(({} as Record<string, unknown>)['poluido']).toBeUndefined();
  });
});
