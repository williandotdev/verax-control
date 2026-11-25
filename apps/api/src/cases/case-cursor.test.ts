import { describe, expect, it } from 'vitest';
import { CASE_CURSOR_START, caseCursorScope, decodeCaseCursor, encodeCaseCursor } from './case-cursor.js';

const CASE = '018f2c1e-0000-7000-8000-000000000001';
const ID = '018f2c1e-0000-7000-8000-00000000000a';
const AT = new Date('2026-11-24T12:34:56.789Z');
const SCOPE = caseCursorScope(CASE, {});

const raw = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const rawText = (value: string): string => Buffer.from(value).toString('base64url');

describe('o cursor dos alertas de um caso', () => {
  it('vai e volta, só com os caracteres de uma URL', () => {
    const cursor = encodeCaseCursor(AT, ID, SCOPE);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    expect(decodeCaseCursor(cursor, SCOPE)).toEqual({ at: '2026-11-24T12:34:56.789Z', id: ID });
  });

  it.each(['0001-01-01T00:00:00.000Z', '1969-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'])(
    'os extremos do horário: %s',
    (at) => {
      const cursor = encodeCaseCursor(new Date(at), ID, SCOPE);
      expect(decodeCaseCursor(cursor, SCOPE)).toEqual({ at, id: ID });
    },
  );

  it('o começo da lista vem antes de qualquer alerta', () => {
    expect(CASE_CURSOR_START).toEqual({ at: 'infinity', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
  });

  it('a marca muda com o caso e com cada filtro, e um filtro não se confunde com outro', () => {
    const scopes = [
      SCOPE,
      caseCursorScope('018f2c1e-0000-7000-8000-000000000002', {}),
      caseCursorScope(CASE, { status: 'new' }),
      caseCursorScope(CASE, { severity: 'high' }),
      caseCursorScope(CASE, { group: 'high' }),
      caseCursorScope(CASE, { group: 'new' }),
      caseCursorScope(CASE, { status: 'new', group: 'high' }),
      caseCursorScope(CASE, { severity: 'high', group: 'new' }),
    ];
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(caseCursorScope(CASE, { status: undefined, severity: undefined })).toBe(SCOPE);
    for (const scope of scopes) expect(scope).toMatch(/^[0-9a-f]{16}$/);
  });

  it('o cursor de outra lista não vale', () => {
    const cursor = encodeCaseCursor(AT, ID, SCOPE);
    expect(decodeCaseCursor(cursor, caseCursorScope(CASE, { status: 'new' }))).toBeNull();
    expect(decodeCaseCursor(cursor, caseCursorScope(ID, {}))).toBeNull();
  });

  it.each([
    ['vazio', ''],
    ['texto qualquer', 'abc'],
    ['JSON que não é lista', raw({ at: 1 })],
    ['nulo', raw(null)],
    ['outra versão', raw([2, AT.getTime(), ID, SCOPE])],
    ['campo a menos', raw([1, AT.getTime(), ID])],
    ['campo a mais', raw([1, AT.getTime(), ID, SCOPE, 'x'])],
    ['horário em texto', raw([1, AT.toISOString(), ID, SCOPE])],
    ['horário com fração', raw([1, 1.5, ID, SCOPE])],
    ['horário antes do ano 1', raw([1, Date.parse('0001-01-01T00:00:00.000Z') - 1, ID, SCOPE])],
    ['horário depois do ano 9999', raw([1, Date.parse('9999-12-31T23:59:59.999Z') + 1, ID, SCOPE])],
    ['horário infinito', rawText(`[1,1e400,"${ID}","${SCOPE}"]`)],
    ['id que não é UUID', raw([1, AT.getTime(), 'x OR true', SCOPE])],
    ['id em maiúsculas', raw([1, AT.getTime(), ID.toUpperCase(), SCOPE])],
    ['marca que não é marca', raw([1, AT.getTime(), ID, 'zzzz'])],
    ['espaço no JSON', rawText(`[1, ${AT.getTime()},"${ID}","${SCOPE}"]`)],
    ['número escrito de outro jeito', rawText(`[1,17e11,"${ID}","${SCOPE}"]`)],
    ['sobra no fim', `${encodeCaseCursor(AT, ID, SCOPE)}A`],
    ['base64 comum, com preenchimento', `${encodeCaseCursor(AT, ID, SCOPE)}==`],
  ])('recusa sem lançar: %s', (_name, cursor) => {
    expect(decodeCaseCursor(cursor, SCOPE)).toBeNull();
  });

  it('trocar um caractere nunca dá um lugar que não existe', () => {
    const cursor = encodeCaseCursor(AT, ID, SCOPE);
    for (let index = 0; index < cursor.length; index += 1) {
      const other = cursor.charAt(index) === 'A' ? 'B' : 'A';
      const changed = cursor.slice(0, index) + other + cursor.slice(index + 1);
      const position = decodeCaseCursor(changed, SCOPE);
      // Pode ser outro lugar da mesma lista (o horário ou o id mudado), sempre um lugar válido.
      if (position !== null) {
        expect(encodeCaseCursor(new Date(position.at), position.id, SCOPE)).toBe(changed);
      }
    }
  });
});
