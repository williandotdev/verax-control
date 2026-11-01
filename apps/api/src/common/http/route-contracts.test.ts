import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findNonStrictObjects } from './route-contracts.js';

describe('findNonStrictObjects', () => {
  it('aceita objetos estritos em qualquer profundidade', () => {
    const schema = z.strictObject({
      tags: z.array(z.strictObject({ name: z.string() })).optional(),
      meta: z.record(z.string(), z.strictObject({ v: z.number() })),
      choice: z.union([z.strictObject({ a: z.string() }), z.literal('none')]),
      trimmed: z.string().transform((value) => value.trim()),
    });
    expect(findNonStrictObjects(schema)).toEqual([]);
  });

  it('aponta o caminho de cada objeto que aceita chaves desconhecidas', () => {
    const schema = z.strictObject({
      a: z.object({ x: z.string() }),
      b: z.array(z.looseObject({ y: z.string() })).nullable(),
      c: z.union([z.strictObject({}), z.object({ z: z.string() })]),
      d: z.record(z.string(), z.object({})),
      e: z.strictObject({}).and(z.object({ w: z.string() })),
    });
    expect(findNonStrictObjects(schema).sort()).toEqual(['$.a', '$.b[]', '$.c', '$.d[*]', '$.e'].sort());
  });

  it('pega o objeto raiz não estrito', () => {
    expect(findNonStrictObjects(z.object({}))).toEqual(['$']);
  });
});
