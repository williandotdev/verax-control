import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { AuditService } from '../../src/audit/audit.service.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import {
  type CostModelStore,
  DraftChangedError,
  EffectiveFromError,
  LegacyVersionError,
  type PricingTableStore,
  type PublishCheck,
  VersionExistsError,
  VersionImmutableError,
  VersionNotFoundError,
} from '../../src/pricing/pricing-store.js';
import { priceTableSchema } from '../../src/pricing/pricing.schema.js';
import {
  QUOTE_DAILY_LIMIT,
  QUOTE_TTL_MS,
  QuoteDailyLimitReachedError,
  quoteDailyBucket,
  type QuoteStore,
} from '../../src/pricing/quote-store.js';
import { quote } from '../../src/pricing/quote.js';
import { type FakeClock, MINUTE_MS } from './fake-clock.js';
import { fictitiousCostModel, fictitiousPriceTable } from './pricing-fixtures.js';

export interface PricingStoreHarness {
  tables: PricingTableStore;
  costs: CostModelStore;
  quotes: QuoteStore;
  audit: AuditService;
  clock: FakeClock;
  documents: DocumentStore;
}

/** O responsável fictício (o e-mail da sessão do console). */
const OWNER = { email: 'responsavel@verax.example', requestId: 'req-demo-00042' };

function check(version: string): PublishCheck {
  return {
    priceTableVersion: version,
    costModelVersion: 'custos-teste-v1',
    ok: true,
    checkedConfigurations: 10,
    belowMinimum: 0,
    belowAlert: 1,
    worstMargin: 0.5,
    minimumMargin: 0.3,
    alertMargin: 0.35,
    at: new Date('2026-11-04T12:00:00.000Z'),
  };
}

/**
 * Contrato dos repositórios do preço configurável (tabelas de preços, modelos de custo e cotações), rodado contra o
 * dublê em memória e contra o emulador oficial do Firestore. Conteúdo FICTÍCIO (`pricing-fixtures.ts`).
 */
export function describePricingStoreContract(
  name: string,
  factory: () => Promise<PricingStoreHarness>,
): void {
  describe(`repositórios do preço configurável (${name})`, () => {
    let h: PricingStoreHarness;

    beforeEach(async () => {
      h = await factory();
    });

    async function actions(): Promise<string[]> {
      const docs = await h.documents.query(COLLECTIONS.auditLog, { orderBy: { field: 'at' } });
      return docs.map((doc) => String(doc.data['action']));
    }

    it('rascunho: cria, valida o conteúdo, recusa versão repetida e audita como owner:<e-mail>', async () => {
      const draft = await h.tables.createDraft('teste-v1', fictitiousPriceTable(), OWNER);

      expect(draft).toMatchObject({
        version: 'teste-v1',
        status: 'draft',
        createdBy: OWNER.email,
        updatedBy: OWNER.email,
        createdAt: h.clock.now(),
      });
      expect(draft.content).toEqual(priceTableSchema.parse(fictitiousPriceTable()));
      expect(await h.tables.get('teste-v1')).toEqual(draft);
      await expect(h.tables.createDraft('teste-v1', fictitiousPriceTable(), OWNER)).rejects.toBeInstanceOf(
        VersionExistsError,
      );
      await expect(
        h.tables.createDraft('teste-v2', { ...fictitiousPriceTable(), currency: 'usd' }, OWNER),
      ).rejects.toBeInstanceOf(ZodError);
      expect(await h.tables.get('teste-v2')).toBeUndefined();
      const [created] = await h.documents.query(COLLECTIONS.auditLog);
      expect(created?.data).toMatchObject({
        actor: `owner:${OWNER.email}`,
        action: 'pricing.draft.created',
        details: { version: 'teste-v1' },
        requestId: OWNER.requestId,
      });
    });

    it('editar o rascunho grava a diferença na auditoria (caminho, antes e depois); sem mudança, nada é gravado', async () => {
      await h.tables.createDraft('teste-v1', fictitiousPriceTable(), OWNER);
      h.clock.advance(MINUTE_MS);
      const changed = fictitiousPriceTable();
      changed.plans.vciso.service.amount = 250_000;

      const updated = await h.tables.updateDraft('teste-v1', changed, OWNER);

      expect(updated.content.plans.vciso.service.amount).toBe(250_000);
      expect(updated.updatedAt).toEqual(h.clock.now());
      const audit = await h.documents.query(COLLECTIONS.auditLog, { orderBy: { field: 'at' } });
      expect(audit.map((doc) => doc.data['action'])).toEqual([
        'pricing.draft.created',
        'pricing.draft.updated',
      ]);
      expect(audit[1]?.data['details']).toEqual({
        version: 'teste-v1',
        changes: [{ path: 'plans.vciso.service.amount', before: 200_000, after: 250_000 }],
      });

      await h.tables.updateDraft('teste-v1', changed, OWNER);
      expect(await actions()).toHaveLength(2);
      await expect(h.tables.updateDraft('inexistente', changed, OWNER)).rejects.toBeInstanceOf(
        VersionNotFoundError,
      );
    });

    it('publicar: vigente a partir de agora, a anterior vira aposentada; publicada é imutável', async () => {
      const first = await h.tables.createDraft('teste-v1', fictitiousPriceTable(), OWNER);
      const published = await h.tables.publish(
        'teste-v1',
        { expectedUpdatedAt: first.updatedAt, publishCheck: check('teste-v1') },
        OWNER,
      );
      expect(published).toMatchObject({
        status: 'published',
        effectiveFrom: h.clock.now(),
        publishedAt: h.clock.now(),
        publishedBy: OWNER.email,
        publishCheck: check('teste-v1'),
      });
      expect((await h.tables.current())?.version).toBe('teste-v1');
      await expect(h.tables.updateDraft('teste-v1', fictitiousPriceTable(), OWNER)).rejects.toBeInstanceOf(
        VersionImmutableError,
      );
      await expect(
        h.tables.publish('teste-v1', { expectedUpdatedAt: published.updatedAt }, OWNER),
      ).rejects.toBeInstanceOf(VersionImmutableError);

      h.clock.advance(MINUTE_MS);
      const second = await h.tables.createDraft('teste-v2', fictitiousPriceTable(), OWNER);
      await h.tables.publish('teste-v2', { expectedUpdatedAt: second.updatedAt }, OWNER);

      expect((await h.tables.current())?.version).toBe('teste-v2');
      expect(await h.tables.get('teste-v1')).toMatchObject({
        status: 'retired',
        retiredAt: h.clock.now(),
        supersededBy: 'teste-v2',
        // O conteúdo publicado nunca muda.
        content: priceTableSchema.parse(fictitiousPriceTable()),
      });
      expect(await actions()).toEqual([
        'pricing.draft.created',
        'pricing.published',
        'pricing.draft.created',
        'pricing.published',
        'pricing.retired',
      ]);
      const list = await h.tables.list();
      expect(list.map((entry) => [entry.version, entry.status, entry.current])).toEqual([
        ['teste-v2', 'published', true],
        ['teste-v1', 'retired', false],
      ]);
      // Quem publicou e quem editou por último vão no resumo (a lista do console), sem o conteúdo.
      expect(list[0]).toMatchObject({ publishedBy: OWNER.email, updatedBy: OWNER.email });
      expect(list[0]).not.toHaveProperty('content');
    });

    it('legado (o modelo de preço anterior): na lista marcado, nunca vigente, não abre; a primeira versão nova o aposenta', async () => {
      // Um documento publicado no formato de antes da troca, gravado direto no banco (o conteúdo não passa no schema).
      const at = h.clock.now();
      await h.documents.runTransaction((tx) => {
        tx.set(COLLECTIONS.pricingTables, 'antigo-v1', {
          status: 'published',
          content: { currency: 'brl', interval: 'month', modes: {}, cloudAccounts: { included: 1 } },
          effectiveFrom: at,
          publishedAt: at,
          publishedBy: OWNER.email,
          createdAt: at,
          createdBy: OWNER.email,
          updatedAt: at,
          updatedBy: OWNER.email,
        });
        return Promise.resolve();
      });

      expect(await h.tables.current()).toBeUndefined();
      await expect(h.tables.get('antigo-v1')).rejects.toBeInstanceOf(LegacyVersionError);
      expect(await h.tables.list()).toEqual([
        expect.objectContaining({ version: 'antigo-v1', status: 'published', current: false, legacy: true }),
      ]);

      h.clock.advance(MINUTE_MS);
      const next = await h.tables.createDraft('teste-v2', fictitiousPriceTable(), OWNER);
      await h.tables.publish('teste-v2', { expectedUpdatedAt: next.updatedAt }, OWNER);

      expect((await h.tables.current())?.version).toBe('teste-v2');
      const list = await h.tables.list();
      expect(list.map((entry) => [entry.version, entry.status, entry.current, entry.legacy])).toEqual([
        ['teste-v2', 'published', true, undefined],
        ['antigo-v1', 'retired', false, true],
      ]);
      // Aposentado pelo envelope: o conteúdo de antes fica como estava.
      expect(await h.documents.get(COLLECTIONS.pricingTables, 'antigo-v1')).toMatchObject({
        status: 'retired',
        retiredAt: h.clock.now(),
        supersededBy: 'teste-v2',
        content: { currency: 'brl', interval: 'month', modes: {}, cloudAccounts: { included: 1 } },
      });
      expect(await actions()).toEqual(['pricing.draft.created', 'pricing.published', 'pricing.retired']);
    });

    it('publicação agendada: a vigente continua até a data da nova, que então passa a valer', async () => {
      const first = await h.tables.createDraft('teste-v1', fictitiousPriceTable(), OWNER);
      await h.tables.publish('teste-v1', { expectedUpdatedAt: first.updatedAt }, OWNER);
      const second = await h.tables.createDraft('teste-v2', fictitiousPriceTable(), OWNER);
      const from = new Date(h.clock.now().getTime() + 60 * MINUTE_MS);

      await h.tables.publish('teste-v2', { expectedUpdatedAt: second.updatedAt, effectiveFrom: from }, OWNER);

      expect((await h.tables.current())?.version).toBe('teste-v1');
      expect(await h.tables.get('teste-v1')).toMatchObject({ status: 'retired', retiredAt: from });
      expect((await h.tables.current(new Date(from.getTime() - 1)))?.version).toBe('teste-v1');
      expect((await h.tables.current(from))?.version).toBe('teste-v2');
      h.clock.set(from);
      expect((await h.tables.current())?.version).toBe('teste-v2');
    });

    it('vigência no passado, antes da última publicada ou rascunho mudado durante a checagem: nada é publicado', async () => {
      const first = await h.tables.createDraft('teste-v1', fictitiousPriceTable(), OWNER);
      const past = new Date(h.clock.now().getTime() - 1);
      await expect(
        h.tables.publish('teste-v1', { expectedUpdatedAt: first.updatedAt, effectiveFrom: past }, OWNER),
      ).rejects.toEqual(new EffectiveFromError('in_past'));

      const later = new Date(h.clock.now().getTime() + 120 * MINUTE_MS);
      await h.tables.publish('teste-v1', { expectedUpdatedAt: first.updatedAt, effectiveFrom: later }, OWNER);
      const second = await h.tables.createDraft('teste-v2', fictitiousPriceTable(), OWNER);
      await expect(
        h.tables.publish('teste-v2', { expectedUpdatedAt: second.updatedAt }, OWNER),
      ).rejects.toEqual(new EffectiveFromError('not_after_latest'));

      h.clock.advance(MINUTE_MS);
      const changed = fictitiousPriceTable();
      changed.users.max = 11;
      await h.tables.updateDraft('teste-v2', changed, OWNER);
      await expect(
        h.tables.publish(
          'teste-v2',
          { expectedUpdatedAt: second.updatedAt, effectiveFrom: new Date(later.getTime() + 1) },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(DraftChangedError);
      expect((await h.tables.get('teste-v2'))?.status).toBe('draft');
      expect((await h.tables.current(later))?.version).toBe('teste-v1');
    });

    it('modelos de custo: o mesmo ciclo, com auditoria `costs.*`; o vigente é o publicado mais recente', async () => {
      expect(await h.costs.current()).toBeUndefined();
      const draft = await h.costs.createDraft('custos-teste-v1', fictitiousCostModel(), OWNER);
      await h.costs.publish('custos-teste-v1', { expectedUpdatedAt: draft.updatedAt }, OWNER);
      h.clock.advance(MINUTE_MS);
      const next = await h.costs.createDraft('custos-teste-v2', fictitiousCostModel(), OWNER);
      await h.costs.publish('custos-teste-v2', { expectedUpdatedAt: next.updatedAt }, OWNER);

      expect((await h.costs.current())?.version).toBe('custos-teste-v2');
      expect((await h.costs.get('custos-teste-v1'))?.status).toBe('retired');
      expect(await actions()).toEqual([
        'costs.draft.created',
        'costs.published',
        'costs.draft.created',
        'costs.published',
        'costs.retired',
      ]);
      // Tabelas e modelos não se misturam.
      expect(await h.tables.current()).toBeUndefined();
    });

    it('cotação: gravada com id novo e validade de 24 h, sem dado pessoal; vencida, não vale mais', async () => {
      const table = priceTableSchema.parse(fictitiousPriceTable());
      const outcome = quote({ plan: 'plataforma', gbDay: 4, mode: 'managed' }, table);
      if (outcome.kind !== 'quote') throw new Error('sob consulta');

      const stored = await h.quotes.create('teste-v1', outcome.quote);

      expect(stored).toMatchObject({
        priceTableVersion: 'teste-v1',
        configuration: outcome.quote.configuration,
        lineItems: outcome.quote.lineItems,
        monthlyTotal: 160_000,
        setupTotal: 0,
        limits: outcome.quote.limits,
        createdAt: h.clock.now(),
        expiresAt: new Date(h.clock.now().getTime() + QUOTE_TTL_MS),
      });
      expect(await h.quotes.getValid(stored.quoteId)).toEqual(stored);
      const bucket = quoteDailyBucket(h.clock.now());
      expect(await h.documents.get(COLLECTIONS.rateLimits, bucket.id)).toEqual({
        count: 1,
        expiresAt: bucket.endsAt,
      });
      expect(await h.quotes.getValid('nao-e-ulid')).toBeUndefined();
      expect(await h.quotes.getValid('01JBZZZZZZZZZZZZZZZZZZZZZZ')).toBeUndefined();

      h.clock.advance(QUOTE_TTL_MS);
      expect(await h.quotes.getValid(stored.quoteId)).toBeUndefined();
    });

    it('cotação do modelo de preço anterior (gravada antes da troca, ainda nas 24 h): não vale, sem erro', async () => {
      const quoteId = '01JBTESTE0000000000000000Q';
      await h.documents.runTransaction((tx) => {
        tx.set(COLLECTIONS.quotes, quoteId, {
          priceTableVersion: 'antigo-v1',
          configuration: { mode: 'managed', size: 'P', cloudAccounts: 2, monthlyGib: 10 },
          createdAt: h.clock.now(),
          expiresAt: new Date(h.clock.now().getTime() + QUOTE_TTL_MS),
        });
        return Promise.resolve();
      });
      expect(await h.quotes.getValid(quoteId)).toBeUndefined();
    });

    it(`cotação: o teto de ${QUOTE_DAILY_LIMIT} por dia (UTC) recusa a próxima sem gravar`, async () => {
      const bucket = quoteDailyBucket(h.clock.now());
      await h.documents.runTransaction((tx) => {
        tx.set(COLLECTIONS.rateLimits, bucket.id, { count: QUOTE_DAILY_LIMIT, expiresAt: bucket.endsAt });
        return Promise.resolve();
      });
      const outcome = quote(
        { plan: 'plataforma', gbDay: 2, mode: 'managed' },
        priceTableSchema.parse(fictitiousPriceTable()),
      );
      if (outcome.kind !== 'quote') throw new Error('sob consulta');

      await expect(h.quotes.create('teste-v1', outcome.quote)).rejects.toBeInstanceOf(
        QuoteDailyLimitReachedError,
      );
      expect(await h.documents.query(COLLECTIONS.quotes)).toHaveLength(0);
    });
  });
}
