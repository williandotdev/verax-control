import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Ask, EXIT, main } from '../src/cli/cadastro-responsavel.js';
import type { OpenedStore } from '../src/cli/publicar-precos.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryAdminSecrets, seedOwnerSession, totpAt } from './support/admin-auth.js';
import { FakeClock } from './support/fake-clock.js';

/**
 * O `cadastro-responsavel` (a conta do console pela linha de comando, no lugar da antiga tela `/configurar`): o e-mail
 * conferido na lista antes de tudo, a senha lida sem eco (duas vezes, 12 ou mais), o segredo do TOTP mostrado só na
 * saída do terminal, o primeiro código confirmando o aplicativo, os códigos de recuperação uma vez, a recusa de uma
 * conta existente sem `--substituir` (e com o e-mail digitado errado), o encerramento das sessões e a auditoria com a
 * identidade das credenciais. Firestore e cofre em memória; nada fala com o Google.
 */
const OWNER = 'responsavel@verax.example';
const OPERATOR = 'operador@verax.example';
const PROJECT = 'projeto-exemplo';
const PASSWORD = `senha-de-teste-${randomBytes(9).toString('base64url')}`;

let lines: string[];
let store: MemoryDocumentStore;
let secrets: MemoryAdminSecrets;
let clock: FakeClock;
let asked: { question: string; hidden: boolean }[];

const output = (): string => lines.join('\n');

/** O segredo do TOTP que a CLI mostrou (o `secret=` do otpauth://). */
function shownSecret(): string {
  const match = /secret=([A-Z2-7]+)/.exec(output());
  if (match?.[1] === undefined) throw new Error('a CLI não mostrou o otpauth://');
  return match[1];
}

/**
 * As respostas do operador por pergunta: a senha (as duas vezes), o e-mail de confirmação e o código, calculado do
 * segredo que a CLI acabou de mostrar (como o celular faria).
 */
function answers(options: { password?: string[]; confirm?: string; codes?: string[] } = {}): Ask {
  const passwords = [...(options.password ?? [PASSWORD, PASSWORD])];
  const codes = [...(options.codes ?? ['certo'])];
  return async (question, { hidden }) => {
    asked.push({ question, hidden });
    if (question.startsWith('Senha') || question.startsWith('Repita')) return passwords.shift() ?? '';
    if (question.startsWith('Para confirmar')) return options.confirm ?? OWNER;
    if (question.startsWith('Código')) {
      const next = codes.shift() ?? '000000';
      return next === 'certo' ? totpAt(shownSecret(), clock.now()) : next;
    }
    throw new Error(`pergunta inesperada: ${question}`);
  };
}

function run(argv: string[], ask: Ask = answers(), env: Record<string, string> = {}): Promise<number> {
  return main({
    argv: [`--projeto=${PROJECT}`, ...argv],
    env: { OWNER_PRINCIPALS: `user:${OWNER}`, ...env },
    out: (line) => lines.push(line),
    ask,
    clock,
    identity: () => Promise.resolve(OPERATOR),
    secrets: () => secrets,
    openStore: (): OpenedStore => ({ store, close: () => Promise.resolve() }),
  });
}

beforeEach(() => {
  lines = [];
  asked = [];
  store = new MemoryDocumentStore();
  secrets = new MemoryAdminSecrets();
  clock = new FakeClock(new Date('2026-11-12T12:00:00.000Z'));
});

describe('cadastro-responsavel (CLI)', () => {
  it('--novo: senha sem eco, otpauth só na saída, código confirmado, 10 códigos de recuperação e auditoria', async () => {
    expect(await run([`--email=${OWNER.toUpperCase()}`, '--novo'])).toBe(EXIT.ok);
    // A senha é perguntada sem eco; o código, não.
    expect(asked.filter((entry) => entry.hidden).map((entry) => entry.question)).toEqual([
      'Senha nova (12 caracteres ou mais): ',
      'Repita a senha: ',
    ]);
    const secret = shownSecret();
    expect(output()).toContain('otpauth://totp/');
    const recovery = lines.filter((line) => /^ {2}[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(line));
    expect(recovery).toHaveLength(10);
    // Nada em claro no banco: nem a senha, nem o segredo, nem os códigos.
    const accounts = await store.query(COLLECTIONS.adminAccounts);
    expect(accounts).toHaveLength(1);
    const stored = JSON.stringify(accounts);
    for (const value of [PASSWORD, secret, ...recovery.map((line) => line.trim())]) {
      expect(stored).not.toContain(value);
    }
    expect(output()).not.toContain(PASSWORD);
    const [audit] = await store.query(COLLECTIONS.auditLog);
    expect(audit?.data).toMatchObject({
      actor: `owner:${OPERATOR}`,
      action: 'admin.account_created',
      details: { account: OWNER, via: 'cli' },
    });
  });

  it('e-mail fora da lista, sem lista ou sem --email: recusa antes de perguntar ou abrir o banco', async () => {
    expect(await run(['--email=outra-pessoa@verax.example', '--novo'])).toBe(EXIT.refused);
    expect(await run([`--email=${OWNER}`, '--novo'], answers(), { OWNER_PRINCIPALS: '' })).toBe(EXIT.usage);
    expect(await run(['--novo'])).toBe(EXIT.usage);
    expect(await run([])).toBe(EXIT.usage);
    expect(await run(['--substituir'])).toBe(EXIT.usage);
    expect(asked).toHaveLength(0);
    expect(await store.query(COLLECTIONS.adminAccounts)).toHaveLength(0);
  });

  it('a lista também vem de --responsaveis', async () => {
    expect(
      await run(
        [`--email=${OWNER}`, '--novo', `--responsaveis=user:outro@verax.example,${OWNER}`],
        answers(),
        { OWNER_PRINCIPALS: '' },
      ),
    ).toBe(EXIT.ok);
  });

  it('senha curta ou diferente três vezes, ou código errado três vezes: nada gravado', async () => {
    const short = answers({ password: ['curta', 'curta', PASSWORD, `${PASSWORD}x`, 'curta'] });
    expect(await run([`--email=${OWNER}`, '--novo'], short)).toBe(EXIT.refused);
    expect(output()).not.toContain('otpauth://');
    lines = [];
    const wrong = answers({ codes: ['000000', '111111', '222222'] });
    expect(await run([`--email=${OWNER}`, '--novo'], wrong)).toBe(EXIT.refused);
    expect(await store.query(COLLECTIONS.adminAccounts)).toHaveLength(0);
    expect(await store.query(COLLECTIONS.auditLog)).toHaveLength(0);
    // Errar e acertar na segunda vale.
    lines = [];
    expect(await run([`--email=${OWNER}`, '--novo'], answers({ codes: ['000000', 'certo'] }))).toBe(EXIT.ok);
  });

  it('conta existente: recusa sem --substituir; com ele, só com o e-mail digitado de novo, e as sessões caem', async () => {
    expect(await run([`--email=${OWNER}`, '--novo'])).toBe(EXIT.ok);
    const [before] = await store.query(COLLECTIONS.adminAccounts);
    await seedOwnerSession(store, clock, OWNER);

    lines = [];
    expect(await run([`--email=${OWNER}`, '--novo'])).toBe(EXIT.refused);
    expect(output()).toContain('--substituir');
    lines = [];
    expect(
      await run([`--email=${OWNER}`, '--novo', '--substituir'], answers({ confirm: 'outro@verax.example' })),
    ).toBe(EXIT.refused);
    expect((await store.query(COLLECTIONS.adminAccounts))[0]?.data).toEqual(before?.data);
    expect(await store.query(COLLECTIONS.adminSessions)).toHaveLength(1);

    lines = [];
    clock.advance(60_000);
    expect(await run([`--email=${OWNER}`, '--novo', '--substituir'])).toBe(EXIT.ok);
    expect(output()).toContain('Conta substituída');
    expect((await store.query(COLLECTIONS.adminAccounts))[0]?.data['passwordHash']).not.toEqual(
      before?.data['passwordHash'],
    );
    expect(await store.query(COLLECTIONS.adminSessions)).toHaveLength(0);
    const actions = (await store.query(COLLECTIONS.auditLog)).map((doc) => doc.data['action']);
    expect(actions).toContain('admin.account_replaced');
  });

  it('--encerrar-sessoes apaga todas as sessões, sem pedir nada', async () => {
    await seedOwnerSession(store, clock, OWNER);
    await seedOwnerSession(store, clock, 'outro@verax.example');
    expect(await run(['--encerrar-sessoes'])).toBe(EXIT.ok);
    expect(asked).toHaveLength(0);
    expect(output()).toContain('Sessões do console encerradas: 2.');
    expect(await store.query(COLLECTIONS.adminSessions)).toHaveLength(0);
  });

  it('sem a chave do cofre ou sem as credenciais: erro, nada perguntado nem gravado', async () => {
    secrets.totp = undefined;
    expect(await run([`--email=${OWNER}`, '--novo'])).toBe(EXIT.backend);
    expect(output()).toContain('cp-admin-totp-key');
    expect(asked).toHaveLength(0);
    secrets.totp = 'curta';
    expect(await run([`--email=${OWNER}`, '--novo'])).toBe(EXIT.backend);
    const noIdentity = await main({
      argv: [`--projeto=${PROJECT}`, `--email=${OWNER}`, '--novo'],
      env: { OWNER_PRINCIPALS: OWNER },
      out: (line) => lines.push(line),
      ask: answers(),
      identity: () => Promise.reject(new Error('sem credenciais')),
      secrets: () => secrets,
      openStore: (): OpenedStore => ({ store, close: () => Promise.resolve() }),
    });
    expect(noIdentity).toBe(EXIT.backend);
    expect(await store.query(COLLECTIONS.adminAccounts)).toHaveLength(0);
  });
});
