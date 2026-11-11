import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { AuditService } from '../../src/audit/audit.service.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import {
  LegalDraftChangedError,
  LegalTextEmptyError,
  type LegalTextStore,
  LegalVersionExistsError,
  LegalVersionImmutableError,
  LegalVersionNotFoundError,
  sha256Hex,
} from '../../src/legal/legal-store.js';
import { MAX_LEGAL_TEXT_BYTES } from '../../src/legal/legal.schema.js';
import { type FakeClock, MINUTE_MS } from './fake-clock.js';

export interface LegalStoreHarness {
  store: LegalTextStore;
  audit: AuditService;
  clock: FakeClock;
  documents: DocumentStore;
}

/** O responsável fictício (o e-mail da sessão do console). */
const OWNER = { email: 'responsavel@verax.example', requestId: 'req-demo-00042' };
const TEXT = '# Termos de teste\n\nTexto fictício.\n';

/**
 * Contrato do repositório dos textos legais, rodado contra o dublê em memória e contra o emulador oficial do Firestore.
 * Textos FICTÍCIOS.
 */
export function describeLegalStoreContract(name: string, create: () => Promise<LegalStoreHarness>): void {
  describe(`LegalTextStore (${name})`, () => {
    let h: LegalStoreHarness;

    beforeEach(async () => {
      h = await create();
    });

    async function auditActions(): Promise<string[]> {
      const docs = await h.documents.query(COLLECTIONS.auditLog, { orderBy: { field: 'at' } });
      return docs.map((doc) => String(doc.data['action']));
    }

    /** Cria, escreve e publica uma versão; devolve a publicada. */
    async function publish(version: string, content = TEXT, kind: 'terms' | 'dpa' = 'terms') {
      const draft = await h.store.createDraft(kind, version, {}, OWNER);
      h.clock.advance(MINUTE_MS);
      const saved = await h.store.updateDraft(
        kind,
        version,
        content,
        { expectedUpdatedAt: draft.updatedAt },
        OWNER,
      );
      return h.store.publish(kind, version, { expectedUpdatedAt: saved.updatedAt }, OWNER);
    }

    it('rascunho em branco, edição, publicação: a vigente é a publicada, com quem, quando e o hash', async () => {
      const draft = await h.store.createDraft('terms', '2026-11-10', {}, OWNER);
      expect(draft).toMatchObject({ kind: 'terms', version: '2026-11-10', status: 'draft', content: '' });
      expect(await h.store.current('terms')).toBeUndefined();

      h.clock.advance(MINUTE_MS);
      const saved = await h.store.updateDraft(
        'terms',
        '2026-11-10',
        'linha 1\r\nlinha 2',
        { expectedUpdatedAt: draft.updatedAt },
        OWNER,
      );
      expect(saved.content).toBe('linha 1\nlinha 2');
      expect(saved.updatedAt).toEqual(h.clock.now());

      h.clock.advance(MINUTE_MS);
      const published = await h.store.publish(
        'terms',
        '2026-11-10',
        { expectedUpdatedAt: saved.updatedAt },
        OWNER,
      );
      expect(published).toMatchObject({
        status: 'published',
        publishedAt: h.clock.now(),
        publishedBy: OWNER.email,
        contentSha256: sha256Hex('linha 1\nlinha 2'),
      });
      expect((await h.store.current('terms'))?.version).toBe('2026-11-10');
      expect(await h.store.currentVersions()).toEqual({
        terms: '2026-11-10',
        privacy: undefined,
        dpa: undefined,
      });
      expect(await auditActions()).toEqual([
        'legal.terms.draft.created',
        'legal.terms.draft.updated',
        'legal.terms.published',
      ]);
    });

    it('publicada não muda nem é republicada; a versão nova vira a vigente e a antiga continua legível', async () => {
      const first = await publish('v1', 'primeiro');
      await expect(
        h.store.updateDraft('terms', 'v1', 'outro', { expectedUpdatedAt: first.updatedAt }, OWNER),
      ).rejects.toBeInstanceOf(LegalVersionImmutableError);
      await expect(
        h.store.publish('terms', 'v1', { expectedUpdatedAt: first.updatedAt }, OWNER),
      ).rejects.toBeInstanceOf(LegalVersionImmutableError);

      h.clock.advance(MINUTE_MS);
      const copy = await h.store.createDraft('terms', 'v2', { from: 'v1' }, OWNER);
      expect(copy).toMatchObject({ status: 'draft', content: 'primeiro', basedOn: 'v1' });
      expect((await h.store.current('terms'))?.version).toBe('v1');
      h.clock.advance(MINUTE_MS);
      const saved = await h.store.updateDraft(
        'terms',
        'v2',
        'segundo',
        { expectedUpdatedAt: copy.updatedAt },
        OWNER,
      );
      await h.store.publish('terms', 'v2', { expectedUpdatedAt: saved.updatedAt }, OWNER);

      expect((await h.store.current('terms'))?.version).toBe('v2');
      expect((await h.store.get('terms', 'v1'))?.content).toBe('primeiro');
      const list = await h.store.list('terms');
      expect(list.map((entry) => [entry.version, entry.status, entry.current])).toEqual([
        ['v2', 'published', true],
        ['v1', 'published', false],
      ]);
      expect(list[0]).not.toHaveProperty('content');
      expect(list[0]?.bytes).toBe(7);
    });

    it('duas publicações no mesmo instante: a segunda fica 1 ms depois e é a vigente', async () => {
      const a = await h.store.createDraft('dpa', 'a', {}, OWNER);
      const b = await h.store.createDraft('dpa', 'b', {}, OWNER);
      const savedA = await h.store.updateDraft('dpa', 'a', 'A', { expectedUpdatedAt: a.updatedAt }, OWNER);
      const savedB = await h.store.updateDraft('dpa', 'b', 'B', { expectedUpdatedAt: b.updatedAt }, OWNER);
      const first = await h.store.publish('dpa', 'a', { expectedUpdatedAt: savedA.updatedAt }, OWNER);
      const second = await h.store.publish('dpa', 'b', { expectedUpdatedAt: savedB.updatedAt }, OWNER);
      expect(second.publishedAt?.getTime()).toBe((first.publishedAt?.getTime() ?? 0) + 1);
      expect((await h.store.current('dpa'))?.version).toBe('b');
    });

    it('rascunho que mudou depois da leitura: a edição e a publicação são recusadas, sem gravar', async () => {
      const draft = await h.store.createDraft('terms', 'v1', {}, OWNER);
      h.clock.advance(MINUTE_MS);
      await h.store.updateDraft('terms', 'v1', 'aba A', { expectedUpdatedAt: draft.updatedAt }, OWNER);
      await expect(
        h.store.updateDraft('terms', 'v1', 'aba B', { expectedUpdatedAt: draft.updatedAt }, OWNER),
      ).rejects.toBeInstanceOf(LegalDraftChangedError);
      await expect(
        h.store.publish('terms', 'v1', { expectedUpdatedAt: draft.updatedAt }, OWNER),
      ).rejects.toBeInstanceOf(LegalDraftChangedError);
      expect((await h.store.get('terms', 'v1'))?.content).toBe('aba A');
      expect(await h.store.current('terms')).toBeUndefined();
    });

    it('texto em branco não se publica; versão repetida, origem inexistente e texto grande demais são recusados', async () => {
      const draft = await h.store.createDraft('terms', 'v1', {}, OWNER);
      await expect(
        h.store.publish('terms', 'v1', { expectedUpdatedAt: draft.updatedAt }, OWNER),
      ).rejects.toBeInstanceOf(LegalTextEmptyError);
      await expect(h.store.createDraft('terms', 'v1', {}, OWNER)).rejects.toBeInstanceOf(
        LegalVersionExistsError,
      );
      await expect(h.store.createDraft('terms', 'v2', { from: 'nao-existe' }, OWNER)).rejects.toBeInstanceOf(
        LegalVersionNotFoundError,
      );
      await expect(h.store.createDraft('terms', 'Versão Inválida', {}, OWNER)).rejects.toBeInstanceOf(
        ZodError,
      );
      await expect(
        h.store.updateDraft(
          'terms',
          'v1',
          'x'.repeat(MAX_LEGAL_TEXT_BYTES + 1),
          { expectedUpdatedAt: draft.updatedAt },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(ZodError);
      await expect(
        h.store.updateDraft('terms', 'v1', 'nulo\u0000', { expectedUpdatedAt: draft.updatedAt }, OWNER),
      ).rejects.toBeInstanceOf(ZodError);
      expect(await auditActions()).toEqual(['legal.terms.draft.created']);
    });

    it('a cópia é do mesmo texto: cada tipo tem as suas versões', async () => {
      await publish('v1', 'termos');
      await expect(h.store.createDraft('dpa', 'v2', { from: 'v1' }, OWNER)).rejects.toBeInstanceOf(
        LegalVersionNotFoundError,
      );
      expect(await h.store.list('dpa')).toEqual([]);
    });

    it('a trilha de um texto sai pelo prefixo da ação, da mais nova para a mais antiga, sem a dos outros', async () => {
      await publish('v1', 'termos', 'terms');
      h.clock.advance(MINUTE_MS);
      await publish('v1', 'dpa', 'dpa');
      const trail = await h.audit.listByActionPrefix('legal.terms.', 10);
      expect(trail.map((entry) => entry.action)).toEqual([
        'legal.terms.published',
        'legal.terms.draft.updated',
        'legal.terms.draft.created',
      ]);
      expect(trail[0]).toMatchObject({
        actor: `owner:${OWNER.email}`,
        details: { version: 'v1', contentSha256: sha256Hex('termos') },
      });
      expect(JSON.stringify(trail)).not.toContain('"termos"');
      expect(await h.audit.listByActionPrefix('legal.terms.', 1)).toHaveLength(1);
    });
  });
}
