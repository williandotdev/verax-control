import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COLLECTIONS, COMPOSITE_INDEXES, TTL_FIELD, TTL_FIELDS } from './collections.js';

const indexesFile = new URL('../../firestore.indexes.json', import.meta.url);
const ttlFile = new URL('../../firestore.ttl.json', import.meta.url);

/** Formato do Firebase CLI, o mesmo que o `scripts/firestore-apply.sh` lê com jq. */
const indexesFileSchema = z.strictObject({
  indexes: z.array(
    z.strictObject({
      collectionGroup: z.string().min(1),
      queryScope: z.literal('COLLECTION'),
      fields: z
        .array(z.strictObject({ fieldPath: z.string().min(1), order: z.enum(['ASCENDING', 'DESCENDING']) }))
        .min(2),
    }),
  ),
  fieldOverrides: z.array(z.never()),
});

const ttlFileSchema = z.strictObject({
  fields: z.array(
    z.strictObject({
      collectionGroup: z.string().min(1),
      field: z.literal(TTL_FIELD),
      retention: z.string().min(1),
    }),
  ),
});

describe('índices e TTL do Firestore (CP-02)', () => {
  const indexes = indexesFileSchema.parse(JSON.parse(readFileSync(indexesFile, 'utf8')));
  const ttl = ttlFileSchema.parse(JSON.parse(readFileSync(ttlFile, 'utf8')));

  it('firestore.indexes.json espelha os índices compostos do código', () => {
    expect(indexes.indexes).toEqual(
      COMPOSITE_INDEXES.map((index) => ({
        collectionGroup: index.collectionGroup,
        queryScope: 'COLLECTION',
        fields: index.fields.map((field) => ({ fieldPath: field.fieldPath, order: field.order })),
      })),
    );
  });

  it('tem os quatro índices do plano (§3) sobre tenants: estado mais um prazo', () => {
    const signatures = indexes.indexes.map(
      (index) => `${index.collectionGroup}:${index.fields.map((field) => field.fieldPath).join(',')}`,
    );
    expect(signatures).toEqual([
      'tenants:state,billing.graceUntil',
      'tenants:state,lifecycle.deleteAfter',
      'tenants:state,lifecycle.cryptoDestroyAfter',
      'tenants:state,stateUpdatedAt',
    ]);
  });

  it('firestore.ttl.json espelha os campos de TTL do código', () => {
    expect(ttl.fields).toEqual(TTL_FIELDS);
  });

  it('toda coleção com retenção no plano tem TTL, e as de vida fiscal ou do tenant não têm', () => {
    const withTtl = TTL_FIELDS.map((field) => field.collectionGroup);
    for (const group of [
      COLLECTIONS.slugs,
      COLLECTIONS.stripeEvents,
      COLLECTIONS.statusTokens,
      COLLECTIONS.provisioningRuns,
      'steps',
      COLLECTIONS.auditLog,
      COLLECTIONS.rateLimits,
    ]) {
      expect(withTtl).toContain(group);
    }
    for (const group of [COLLECTIONS.tenants, 'transitions', 'invoices', COLLECTIONS.counters]) {
      expect(withTtl).not.toContain(group);
    }
    expect(new Set(withTtl).size).toBe(withTtl.length);
  });

  it('subcoleções ficam sob o documento pai', () => {
    expect(COLLECTIONS.transitions('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      'tenants/01ARZ3NDEKTSV4RRFFQ69G5FAV/transitions',
    );
    expect(COLLECTIONS.steps('run-1')).toBe('provisioningRuns/run-1/steps');
  });
});
