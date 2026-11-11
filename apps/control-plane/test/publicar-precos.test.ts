import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Firestore } from '@google-cloud/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, main, type OpenedStore } from '../src/cli/publicar-precos.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import type { DocumentStore } from '../src/firestore/document-store.js';
import { createFirestore, FirestoreDocumentStore } from '../src/firestore/firestore-document-store.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { fictitiousCostModel, fictitiousPriceTable } from './support/pricing-fixtures.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';

/**
 * O `publicar-precos` (semear ou publicar a tabela de preços e o modelo de custos sem o console), com os valores
 * FICTÍCIOS dos testes em arquivos temporários fora do repositório: simulação por padrão sem nenhuma escrita, a
 * publicação pelo mesmo serviço do console (rascunho, checagem, vigência e auditoria `owner:<e-mail>`), nada gravado
 * quando a checagem reprova, quando a versão publicada tem outro conteúdo ou quando falta a identidade, e a repetição
 * sem efeito. Por último, o mesmo caminho contra o emulador oficial do Firestore.
 */
const EMAIL = 'responsavel@example.com';
/** Projeto `demo-` só deste arquivo: o emulador é compartilhado e os outros arquivos limpam o banco do deles em paralelo. */
const PROJECT = 'demo-verax-cp-publicar';

let dir: string;
let lines: string[];

function writeVersion(name: string, version: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ version, content }));
  return path;
}

function costFile(overrides: Record<string, unknown> = {}, version = 'custos-teste-v1'): string {
  return writeVersion(`custos-${version}.json`, version, { ...fictitiousCostModel(), ...overrides });
}

function tableFile(overrides: Record<string, unknown> = {}, version = 'tabela-teste-v1'): string {
  return writeVersion(`tabela-${version}.json`, version, { ...fictitiousPriceTable(), ...overrides });
}

interface Harness {
  store: DocumentStore;
  clock: FakeClock;
  opened: number;
  run: (argv: string[], identity?: () => Promise<string>) => Promise<number>;
}

function harness(store: DocumentStore = new MemoryDocumentStore()): Harness {
  const h: Harness = {
    store,
    clock: new FakeClock(),
    opened: 0,
    run: (argv, identity = () => Promise.resolve(EMAIL)) =>
      main({
        argv,
        env: {},
        out: (line) => lines.push(line),
        clock: h.clock,
        identity,
        openStore: (): OpenedStore => {
          h.opened += 1;
          return { store, close: () => Promise.resolve() };
        },
      }),
  };
  return h;
}

async function count(store: DocumentStore, collection: string): Promise<number> {
  return (await store.query(collection)).length;
}

const output = (): string => lines.join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verax-publicar-precos-'));
  lines = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('publicar-precos: uso e arquivos', () => {
  it('sem arquivo, é erro de uso', async () => {
    const h = harness();
    expect(await h.run([])).toBe(EXIT.usage);
    expect(output()).toContain('--custos');
  });

  it('--publicar sem projeto é recusado antes de ler qualquer coisa', async () => {
    const h = harness();
    expect(await h.run([`--custos=${costFile()}`, '--publicar'])).toBe(EXIT.usage);
    expect(h.opened).toBe(0);
  });

  it('arquivo inválido mostra o caminho do problema e não abre o banco', async () => {
    const h = harness();
    const path = costFile({ margins: { minimum: 0.5, alert: 0.4 } });
    expect(await h.run([`--custos=${path}`, `--projeto=${PROJECT}`])).toBe(EXIT.usage);
    expect(output()).toContain('margins.alert');
    expect(h.opened).toBe(0);
  });

  it('arquivo sem { version, content } é recusado', async () => {
    const h = harness();
    const path = join(dir, 'solto.json');
    writeFileSync(path, JSON.stringify(fictitiousCostModel()));
    expect(await h.run([`--custos=${path}`])).toBe(EXIT.usage);
    expect(output()).toContain('"version", "content"');
  });

  it('vigência no passado é recusada', async () => {
    const h = harness();
    const argv = [`--custos=${costFile()}`, `--tabela=${tableFile()}`, '--vigencia=2026-01-01T00:00:00Z'];
    expect(await h.run(argv)).toBe(EXIT.usage);
  });
});

describe('publicar-precos: simulação', () => {
  it('sem projeto, valida e roda a checagem sem abrir o banco', async () => {
    const h = harness();
    expect(await h.run([`--custos=${costFile()}`, `--tabela=${tableFile()}`])).toBe(EXIT.ok);
    expect(h.opened).toBe(0);
    expect(output()).toContain('resultado: APROVADA');
    expect(output()).toContain('plataforma 2 GB/dia: porte P, R$ 1.000,00/mês');
    expect(output()).toContain('vciso 3 GB/dia: porte P, R$ 3.500,00/mês + R$ 5.000,00 uma vez');
  });

  it('a tabela sem modelo de custos (nem arquivo, nem banco) não tem checagem', async () => {
    const h = harness();
    expect(await h.run([`--tabela=${tableFile()}`])).toBe(EXIT.usage);
  });

  it('com projeto, lê o estado e não grava nada', async () => {
    const h = harness();
    const code = await h.run([`--custos=${costFile()}`, `--tabela=${tableFile()}`, `--projeto=${PROJECT}`]);
    expect(code).toBe(EXIT.ok);
    expect(h.opened).toBe(1);
    expect(output()).toContain('criaria o rascunho e publicaria');
    expect(output()).toContain('Simulação: nada foi gravado');
    expect(await count(h.store, COLLECTIONS.costModels)).toBe(0);
    expect(await count(h.store, COLLECTIONS.pricingTables)).toBe(0);
    expect(await count(h.store, COLLECTIONS.auditLog)).toBe(0);
  });

  it('checagem reprovada sai com 1, mesmo na simulação', async () => {
    const h = harness();
    const path = costFile({ margins: { minimum: 0.99, alert: 0.995 } });
    expect(await h.run([`--custos=${path}`, `--tabela=${tableFile()}`])).toBe(EXIT.refused);
    expect(output()).toContain('resultado: REPROVADA');
  });
});

describe('publicar-precos: publicação', () => {
  it('cria e publica o modelo de custos e depois a tabela, com a auditoria do responsável', async () => {
    const h = harness();
    const argv = [`--custos=${costFile()}`, `--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(argv)).toBe(EXIT.ok);

    const cost = await h.store.get(COLLECTIONS.costModels, 'custos-teste-v1');
    const table = await h.store.get(COLLECTIONS.pricingTables, 'tabela-teste-v1');
    expect(cost).toMatchObject({ status: 'published', publishedBy: EMAIL, createdBy: EMAIL });
    expect(table).toMatchObject({
      status: 'published',
      publishedBy: EMAIL,
      publishCheck: { ok: true, costModelVersion: 'custos-teste-v1' },
    });
    const audit = await h.store.query(COLLECTIONS.auditLog);
    expect(audit.map((entry) => entry.data['action']).sort()).toEqual(
      ['costs.draft.created', 'costs.published', 'pricing.draft.created', 'pricing.published'].sort(),
    );
    expect(new Set(audit.map((entry) => entry.data['actor']))).toEqual(new Set([`owner:${EMAIL}`]));
    expect(new Set(audit.map((entry) => entry.data['requestId'])).size).toBe(1);
  });

  it('tabela sem impostos: reprova sem --aliquota-stripe (a do serviço) e publica com ela; id fora do formato é uso', async () => {
    const h = harness();
    const exclusive = tableFile({ taxMode: 'exclusive' });
    const base = [`--custos=${costFile()}`, `--tabela=${exclusive}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(base)).toBe(EXIT.refused);
    expect(output()).toContain('STRIPE_TAX_RATE_ID');
    expect(await count(h.store, COLLECTIONS.pricingTables)).toBe(0);
    expect(await h.run([...base, '--aliquota-stripe=nao-e-alíquota'])).toBe(EXIT.usage);

    expect(await h.run([...base, '--aliquota-stripe=txr_teste_imposto'])).toBe(EXIT.ok);
    expect(await h.store.get(COLLECTIONS.pricingTables, 'tabela-teste-v1')).toMatchObject({
      status: 'published',
      content: { taxMode: 'exclusive' },
      publishCheck: { ok: true },
    });
  });

  it('rodar de novo com o mesmo conteúdo não grava nada', async () => {
    const h = harness();
    const argv = [`--custos=${costFile()}`, `--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(argv)).toBe(EXIT.ok);
    const before = await count(h.store, COLLECTIONS.auditLog);
    h.clock.advance(MINUTE_MS);
    expect(await h.run(argv)).toBe(EXIT.ok);
    expect(output()).toContain('já publicada, nada gravado');
    expect(await count(h.store, COLLECTIONS.auditLog)).toBe(before);
  });

  it('versão publicada com outro conteúdo é conflito e nada é gravado', async () => {
    const h = harness();
    const first = [`--custos=${costFile()}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(first)).toBe(EXIT.ok);
    const before = await count(h.store, COLLECTIONS.auditLog);
    h.clock.advance(MINUTE_MS);
    const changed = costFile({ refundReserveRate: 0.04 });
    const tables = tableFile();
    expect(
      await h.run([`--custos=${changed}`, `--tabela=${tables}`, `--projeto=${PROJECT}`, '--publicar']),
    ).toBe(EXIT.refused);
    expect(output()).toContain('CONFLITO');
    expect(output()).toContain('refundReserveRate');
    expect(await count(h.store, COLLECTIONS.auditLog)).toBe(before);
    expect(await count(h.store, COLLECTIONS.pricingTables)).toBe(0);
  });

  it('checagem reprovada: nada é gravado, nem o modelo de custos', async () => {
    const h = harness();
    const path = costFile({ margins: { minimum: 0.99, alert: 0.995 } });
    const argv = [`--custos=${path}`, `--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(argv)).toBe(EXIT.refused);
    expect(await count(h.store, COLLECTIONS.costModels)).toBe(0);
    expect(await count(h.store, COLLECTIONS.auditLog)).toBe(0);
  });

  it('sem a identidade das credenciais padrão, nada é gravado', async () => {
    const h = harness();
    const argv = [`--custos=${costFile()}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(argv, () => Promise.reject(new Error('sem credenciais')))).toBe(EXIT.backend);
    expect(await count(h.store, COLLECTIONS.costModels)).toBe(0);
  });

  it('só a tabela: a checagem usa o modelo de custos vigente no banco', async () => {
    const h = harness();
    expect(await h.run([`--custos=${costFile()}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    lines = [];
    h.clock.advance(MINUTE_MS);
    expect(await h.run([`--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    expect(output()).toContain('custos-teste-v1 (vigente)');
    expect(await h.store.get(COLLECTIONS.pricingTables, 'tabela-teste-v1')).toMatchObject({
      status: 'published',
    });
  });

  it('um rascunho existente é atualizado (com a diferença na auditoria) antes de publicar', async () => {
    const h = harness();
    expect(await h.run([`--custos=${costFile()}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    h.clock.advance(MINUTE_MS);
    const draft = {
      status: 'draft',
      content: { ...fictitiousPriceTable(), users: { max: 11 } },
      createdAt: h.clock.now(),
      createdBy: EMAIL,
      updatedAt: h.clock.now(),
      updatedBy: EMAIL,
    };
    await h.store.runTransaction((tx) => {
      tx.create(COLLECTIONS.pricingTables, 'tabela-teste-v1', draft);
      return Promise.resolve();
    });
    h.clock.advance(MINUTE_MS);
    expect(await h.run([`--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    expect(output()).toContain('rascunho atualizado');
    const actions = (await h.store.query(COLLECTIONS.auditLog)).map((entry) => entry.data['action']);
    expect(actions).toContain('pricing.draft.updated');
    expect(actions).toContain('pricing.published');
  });

  it('vigência futura agenda a tabela: ela ainda não é a vigente', async () => {
    const h = harness();
    const later = new Date(h.clock.now().getTime() + 60 * MINUTE_MS).toISOString();
    const argv = [
      `--custos=${costFile()}`,
      `--tabela=${tableFile()}`,
      `--projeto=${PROJECT}`,
      `--vigencia=${later}`,
      '--publicar',
    ];
    expect(await h.run(argv)).toBe(EXIT.ok);
    const table = await h.store.get(COLLECTIONS.pricingTables, 'tabela-teste-v1');
    expect((table?.['effectiveFrom'] as Date).toISOString()).toBe(later);
  });
});

describe('publicar-precos: versão aposentada e rascunho que muda', () => {
  /** v1 publicada e depois aposentada pela v2, que reprova a tabela (margem mínima inalcançável). */
  async function retiredV1(h: Harness): Promise<string> {
    const v1 = costFile({}, 'custos-teste-v1');
    expect(await h.run([`--custos=${v1}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    h.clock.advance(MINUTE_MS);
    const v2 = costFile({ margins: { minimum: 0.99, alert: 0.995 } }, 'custos-teste-v2');
    expect(await h.run([`--custos=${v2}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    expect(await h.store.get(COLLECTIONS.costModels, 'custos-teste-v1')).toMatchObject({ status: 'retired' });
    h.clock.advance(MINUTE_MS);
    lines = [];
    return v1;
  }

  it('um modelo de custos aposentado é recusado, e a checagem usa o vigente (o que o serviço usaria)', async () => {
    const h = harness();
    const v1 = await retiredV1(h);
    const argv = [`--custos=${v1}`, `--tabela=${tableFile()}`, `--projeto=${PROJECT}`];
    expect(await h.run(argv)).toBe(EXIT.refused);
    expect(output()).toContain('RECUSADA: a versão custos-teste-v1 está aposentada');
    expect(output()).toContain('modelo de custos custos-teste-v2 (vigente)');
    expect(output()).toContain('resultado: REPROVADA');
  });

  it('com --publicar, o aposentado não grava nada', async () => {
    const h = harness();
    const v1 = await retiredV1(h);
    const before = await count(h.store, COLLECTIONS.auditLog);
    const argv = [`--custos=${v1}`, `--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(argv)).toBe(EXIT.refused);
    expect(await count(h.store, COLLECTIONS.auditLog)).toBe(before);
    expect(await count(h.store, COLLECTIONS.pricingTables)).toBe(0);
  });

  it('o modelo de custos do arquivo já vigente (nada a gravar) é o da checagem', async () => {
    const h = harness();
    const v1 = costFile();
    expect(await h.run([`--custos=${v1}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    h.clock.advance(MINUTE_MS);
    lines = [];
    const argv = [`--custos=${v1}`, `--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(argv)).toBe(EXIT.ok);
    expect(output()).toContain('modelo de custos custos-teste-v1 (arquivo)');
    expect(output()).toContain('modelo de custos custos-teste-v1: já publicada, nada gravado');
  });

  /** Um rascunho da tabela igual ao arquivo, como o console deixaria. */
  async function seedDraft(h: Harness): Promise<void> {
    expect(await h.run([`--custos=${costFile()}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    h.clock.advance(MINUTE_MS);
    await h.store.runTransaction((tx) => {
      tx.create(COLLECTIONS.pricingTables, 'tabela-teste-v1', {
        status: 'draft',
        content: fictitiousPriceTable(),
        createdAt: h.clock.now(),
        createdBy: EMAIL,
        updatedAt: h.clock.now(),
        updatedBy: EMAIL,
      });
      return Promise.resolve();
    });
    h.clock.advance(MINUTE_MS);
    lines = [];
  }

  it('o rascunho igual ao arquivo é publicado na revisão conferida', async () => {
    const h = harness();
    await seedDraft(h);
    expect(await h.run([`--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'])).toBe(EXIT.ok);
    expect(output()).toContain('rascunho igual: publicaria');
    expect(await h.store.get(COLLECTIONS.pricingTables, 'tabela-teste-v1')).toMatchObject({
      status: 'published',
    });
  });

  it('o rascunho editado depois da conferência não é publicado (draft_changed)', async () => {
    const h = harness();
    await seedDraft(h);
    // A identidade é pedida entre a conferência e a publicação: é ali que "outra pessoa" edita o rascunho.
    const editMeanwhile = async (): Promise<string> => {
      h.clock.advance(MINUTE_MS);
      const stored = await h.store.get(COLLECTIONS.pricingTables, 'tabela-teste-v1');
      await h.store.runTransaction((tx) => {
        tx.set(COLLECTIONS.pricingTables, 'tabela-teste-v1', {
          ...stored,
          content: { ...fictitiousPriceTable(), users: { max: 3 } },
          updatedAt: h.clock.now(),
          updatedBy: 'outra-pessoa@example.com',
        });
        return Promise.resolve();
      });
      return EMAIL;
    };
    const argv = [`--tabela=${tableFile()}`, `--projeto=${PROJECT}`, '--publicar'];
    expect(await h.run(argv, editMeanwhile)).toBe(EXIT.refused);
    expect(output()).toContain('draft_changed');
    const table = await h.store.get(COLLECTIONS.pricingTables, 'tabela-teste-v1');
    expect(table).toMatchObject({ status: 'draft', updatedBy: 'outra-pessoa@example.com' });
    const actions = (await h.store.query(COLLECTIONS.auditLog)).map((entry) => entry.data['action']);
    expect(actions).not.toContain('pricing.published');
  });
});

/**
 * O mesmo caminho contra o emulador oficial do Firestore (`scripts/firestore-emulator.sh start`). Sem
 * `FIRESTORE_EMULATOR_HOST`, pulado na máquina de desenvolvimento; no CI, o emulador está sempre no ar.
 */
const host = process.env['FIRESTORE_EMULATOR_HOST'];

describe.skipIf(host === undefined)('publicar-precos: emulador do Firestore', () => {
  let db: Firestore;

  beforeAll(() => {
    db = createFirestore({ FIRESTORE_DATABASE: '(default)', FIRESTORE_PROJECT_ID: PROJECT });
  });

  afterAll(async () => {
    await db.terminate();
  });

  it('simula sem gravar e publica pelo serviço do console', async () => {
    const response = await fetch(
      `http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: 'DELETE' },
    );
    expect(response.ok).toBe(true);
    const h = harness(new FirestoreDocumentStore(db));
    const files = [`--custos=${costFile()}`, `--tabela=${tableFile()}`, `--projeto=${PROJECT}`];
    expect(await h.run(files)).toBe(EXIT.ok);
    expect(await count(h.store, COLLECTIONS.auditLog)).toBe(0);
    expect(await h.run([...files, '--publicar'])).toBe(EXIT.ok);
    expect(await h.store.get(COLLECTIONS.pricingTables, 'tabela-teste-v1')).toMatchObject({
      status: 'published',
      publishedBy: EMAIL,
    });
    expect(await count(h.store, COLLECTIONS.auditLog)).toBe(4);
  });
});
