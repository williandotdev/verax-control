import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COLLECTIONS, COMPOSITE_INDEXES, TTL_FIELD, TTL_FIELDS } from './collections.js';

const indexesFile = new URL('../../firestore.indexes.json', import.meta.url);
const ttlFile = new URL('../../firestore.ttl.json', import.meta.url);
/**
 * Quem cria os índices e o TTL no projeto é o Terraform, e só ele; este arquivo precisa bater com o código. Ele chega
 * pelo PR da infraestrutura do plano de controle: enquanto não está na árvore, a conferência é pulada.
 */
const firestoreTf = new URL('../../../../infra/gcp/envs/control-plane/firestore.tf', import.meta.url);

/** Formato do Firebase CLI (espelho legível; nada o aplica). */
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
      COLLECTIONS.quotes,
      COLLECTIONS.adminSessions,
      COLLECTIONS.adminLoginThrottle,
      COLLECTIONS.adminEnrollments,
    ]) {
      expect(withTtl).toContain(group);
    }
    for (const group of [
      COLLECTIONS.tenants,
      'transitions',
      'invoices',
      COLLECTIONS.counters,
      COLLECTIONS.pricingTables,
      COLLECTIONS.costModels,
      COLLECTIONS.adminAccounts,
      COLLECTIONS.adminSetup,
    ]) {
      expect(withTtl).not.toContain(group);
    }
    expect(new Set(withTtl).size).toBe(withTtl.length);
  });

  it('subcoleções ficam sob o documento pai', () => {
    expect(COLLECTIONS.transitions('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      'tenants/01ARZ3NDEKTSV4RRFFQ69G5FAV/transitions',
    );
    expect(COLLECTIONS.invoices('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      'tenants/01ARZ3NDEKTSV4RRFFQ69G5FAV/invoices',
    );
    expect(COLLECTIONS.steps('run-1')).toBe('provisioningRuns/run-1/steps');
  });

  it('o id do documento pai é validado: nada escapa do caminho da subcoleção', () => {
    for (const bad of ['01AAA/transitions/x', '', '..', 'nao-e-ulid', '01ARZ3NDEKTSV4RRFFQ69G5FAV/']) {
      expect(() => COLLECTIONS.transitions(bad)).toThrow(TypeError);
      expect(() => COLLECTIONS.invoices(bad)).toThrow(TypeError);
    }
    for (const bad of ['run-1/steps/x', '', '.', '..', 'a/b']) {
      expect(() => COLLECTIONS.steps(bad)).toThrow(TypeError);
    }
  });
});

describe.skipIf(!existsSync(firestoreTf))('firestore.tf (Terraform) bate com o código', () => {
  const hcl = existsSync(firestoreTf) ? readFileSync(firestoreTf, 'utf8') : '';

  it('liga o TTL em expiresAt exatamente nas coleções com retenção', () => {
    const block = /resource "google_firestore_field" "ttl" \{[^}]*?for_each\s*=\s*toset\(\[([^\]]*)\]\)/.exec(
      hcl,
    );
    expect(block?.[1]).toBeDefined();
    const groups = [...(block?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    expect(groups).toEqual(TTL_FIELDS.map((field) => field.collectionGroup).sort());
    expect(TTL_FIELD).toBe('expiresAt');
    expect(hcl).toMatch(/field\s*=\s*"expiresAt"/);
  });

  it('declara os mesmos índices compostos de tenants (estado mais um prazo)', () => {
    const block = /resource "google_firestore_index" "tenants" \{\s*for_each\s*=\s*\{([^}]*)\}/.exec(hcl);
    expect(block?.[1]).toBeDefined();
    const secondFields = [...(block?.[1] ?? '').matchAll(/=\s*"([^"]+)"/g)].map((match) => match[1]).sort();
    expect(secondFields).toEqual(COMPOSITE_INDEXES.map((index) => index.fields[1]?.fieldPath).sort());
    expect(COMPOSITE_INDEXES.every((index) => index.collectionGroup === COLLECTIONS.tenants)).toBe(true);
    expect(COMPOSITE_INDEXES.every((index) => index.fields[0]?.fieldPath === 'state')).toBe(true);
    expect(hcl).toMatch(/collection\s*=\s*"tenants"/);
    expect(hcl).toMatch(/field_path\s*=\s*"state"/);
  });
});
