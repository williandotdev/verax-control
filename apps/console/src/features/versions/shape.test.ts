import { describe, expect, it } from 'vitest';
import { fictitiousCostModel, fictitiousPriceTable } from '@/mocks/fixtures';
import { recordsAt, shapeIssues } from './shape';

describe('forma do documento importado', () => {
  it('os documentos fictícios completos não têm problema', () => {
    expect(shapeIssues('cost-models', fictitiousCostModel())).toEqual([]);
    expect(shapeIssues('pricing-tables', fictitiousPriceTable())).toEqual([]);
    expect(shapeIssues('cost-models', {})).toEqual([]);
  });

  it('item nulo, lista como objeto e bloco como texto viram problemas no caminho', () => {
    expect(
      shapeIssues('cost-models', {
        taxes: { rates: [null, { id: 'a' }, 3] },
        fixedCosts: { items: { name: 'x' } },
        exchange: 'dois',
      }),
    ).toEqual([
      { path: 'exchange', message: 'esperado um objeto, recebido string' },
      { path: 'taxes.rates.0', message: 'esperado um objeto, recebido null' },
      { path: 'taxes.rates.2', message: 'esperado um objeto, recebido number' },
      { path: 'fixedCosts.items', message: 'esperada uma lista, recebido object' },
    ]);
    expect(shapeIssues('pricing-tables', { plans: { plataforma: [] }, sizing: { sizes: [null] } })).toEqual([
      { path: 'plans.plataforma', message: 'esperado um objeto, recebido lista' },
      { path: 'sizing.sizes.0', message: 'esperado um objeto, recebido null' },
    ]);
  });

  it('as prévias só leem os itens que são objetos', () => {
    expect(recordsAt({ a: [null, { b: 1 }, 'x'] }, ['a'])).toEqual([{ b: 1 }]);
    expect(recordsAt({ a: { b: 1 } }, ['a'])).toEqual([]);
  });
});
