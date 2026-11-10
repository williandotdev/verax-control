import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { opaqueRef, throttleRef } from '../src/admin/auth/admin-auth.schema.js';
import { LOGIN_FAILED_MESSAGE } from '../src/admin/auth/admin-auth.service.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import type { DocumentTransaction } from '../src/firestore/document-store.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryAdminSecrets, sessionCookie, sessionIdFrom, totpAt } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const START = new Date('2026-11-04T12:00:00.000Z');

/**
 * O Firestore em memória com um gancho: `before(n, fn)` roda `fn` (outra escrita, como a de outra sessão) logo antes da
 * n-ésima transação seguinte. É assim que os testes de corrida põem uma troca de senha entre a conferência e o commit.
 */
class RacingStore extends MemoryDocumentStore {
  private hook: { left: number; fn: () => Promise<void> } | undefined;

  before(transaction: number, fn: () => Promise<void>): void {
    this.hook = { left: transaction, fn };
  }

  override async runTransaction<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    const hook = this.hook;
    if (hook !== undefined) {
      hook.left -= 1;
      if (hook.left === 0) {
        this.hook = undefined;
        await hook.fn();
      }
    }
    return super.runTransaction(fn);
  }
}
/** Responsáveis fictícios (OWNER_PRINCIPALS) e uma pessoa de fora. Senhas geradas a cada execução. */
const OWNER = 'responsavel@verax.example';
const SECOND_OWNER = 'outro-responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';

interface Enrolled {
  password: string;
  secret: string;
  recoveryCodes: string[];
  cookie: string;
}

/**
 * O login próprio do console do responsável (cp-admin) pelo app inteiro: o primeiro cadastro (`/configurar`) com o
 * token do cofre, o login com senha e TOTP (os códigos calculados como o celular calcularia, no relógio do teste), o
 * bloqueio, os códigos de recuperação, a saída, a troca da senha e do aplicativo, e o que nunca vai a log. O Firestore
 * e os cofres em memória; nada fala com o Google. Um app por arquivo.
 */
describe('cp-admin: login próprio do console (senha + TOTP)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new RacingStore();
  const secrets = new MemoryAdminSecrets();
  /** Cada teste numa hora própria: os limites (que contam falhas na memória do processo) não passam de um ao outro. */
  let round = 0;
  let app: NestExpressApplication;
  /** Cada teste com um IP próprio (o limite por IP não passa de um teste ao outro). */
  let ip = '';
  let ipSequence = 0;

  function post(path: string, body: unknown, cookie?: string): request.Test {
    const test = request(app.getHttpServer())
      .post(path)
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json');
    return (cookie === undefined ? test : test.set('Cookie', cookie)).send(JSON.stringify(body));
  }

  function me(cookie: string | undefined): request.Test {
    const test = request(app.getHttpServer()).get('/v1/admin/me').set('X-Forwarded-For', ip);
    return cookie === undefined ? test : test.set('Cookie', cookie);
  }

  function newPassword(): string {
    return `senha-${randomBytes(9).toString('base64url')}`;
  }

  /** O próximo passo de 30 s do relógio (um código novo, que o anti-reuso aceita). */
  function nextStep(): void {
    clock.advance(30_000);
  }

  async function enroll(email = OWNER): Promise<Enrolled> {
    const password = newPassword();
    const started = await post('/v1/admin/setup/start', {
      setupToken: secrets.setup,
      email,
      password,
    }).expect(200);
    const { enrollmentId, secret } = started.body as { enrollmentId: string; secret: string };
    const confirmed = await post('/v1/admin/setup/confirm', {
      enrollmentId,
      code: await totpAt(secret, clock.now()),
    }).expect(200);
    const id = sessionIdFrom(confirmed.headers['set-cookie']);
    expect(id).toBeDefined();
    return {
      password,
      secret,
      recoveryCodes: (confirmed.body as { recoveryCodes: string[] }).recoveryCodes,
      cookie: sessionCookie(id ?? ''),
    };
  }

  function login(email: string, password: string, factor: Record<string, string>): request.Test {
    return post('/v1/admin/login', { email, password, ...factor });
  }

  beforeAll(async () => {
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: secrets,
      env: {
        LOG_LEVEL: 'debug',
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: `${OWNER},${SECOND_OWNER}`,
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  /** Troca o hash da senha da conta direto no Firestore (o que uma troca de senha em outra sessão gravaria). */
  async function changePasswordElsewhere(email = OWNER): Promise<void> {
    const docs = await documents.query(COLLECTIONS.adminAccounts);
    const doc = docs.find((candidate) => candidate.data['email'] === email);
    if (doc === undefined) throw new Error('conta de teste ausente');
    await documents.runTransaction((tx) => {
      tx.set(COLLECTIONS.adminAccounts, doc.id, { ...doc.data, passwordHash: 'trocada-em-outra-sessao' });
      return Promise.resolve();
    });
  }

  beforeEach(() => {
    round += 1;
    clock.set(new Date(START.getTime() + round * 60 * MINUTE_MS));
    documents.clear();
    ipSequence += 1;
    ip = `198.51.100.${ipSequence}`;
    secrets.failing = false;
    secrets.setup = randomBytes(32).toString('base64url');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('primeiro cadastro (/configurar)', () => {
    it('aberto até o primeiro cadastro; token, e-mail de OWNER_PRINCIPALS e senha de 12+; depois fecha', async () => {
      await request(app.getHttpServer()).get('/v1/admin/setup').expect(200, { open: true });
      const password = newPassword();

      // Senha curta: 400 com o campo; nada gravado.
      const short = await post('/v1/admin/setup/start', {
        setupToken: secrets.setup,
        email: OWNER,
        password: 'curta',
      }).expect(400);
      expect(short.body).toMatchObject({
        code: 'invalid_request',
        details: { issues: [{ path: 'password' }] },
      });

      // Token errado ou e-mail de fora: a mesma recusa, sem dizer qual.
      const wrongToken = await post('/v1/admin/setup/start', {
        setupToken: randomBytes(32).toString('base64url'),
        email: OWNER,
        password,
      }).expect(403);
      const stranger = await post('/v1/admin/setup/start', {
        setupToken: secrets.setup,
        email: STRANGER,
        password,
      }).expect(403);
      const { requestId: _first, ...refusedToken } = wrongToken.body as Record<string, unknown>;
      const { requestId: _second, ...refusedEmail } = stranger.body as Record<string, unknown>;
      expect(refusedToken).toEqual(refusedEmail);
      expect(wrongToken.body).toMatchObject({ code: 'setup_refused' });
      expect(await documents.query(COLLECTIONS.adminEnrollments)).toHaveLength(0);

      const started = await post('/v1/admin/setup/start', {
        setupToken: secrets.setup,
        email: OWNER.toUpperCase(),
        password,
      }).expect(200);
      const view = started.body as {
        enrollmentId: string;
        otpauthUri: string;
        secret: string;
        expiresAt: string;
      };
      expect(view.otpauthUri).toContain(`secret=${view.secret}`);
      expect(view.expiresAt).toBe(new Date(clock.now().getTime() + 10 * MINUTE_MS).toISOString());
      // No Firestore, nem o id do cadastro nem o segredo em claro.
      const pending = await documents.query(COLLECTIONS.adminEnrollments);
      expect(pending.map((doc) => doc.id)).toEqual([opaqueRef(view.enrollmentId)]);
      expect(JSON.stringify(pending)).not.toContain(view.secret);
      expect(JSON.stringify(pending)).not.toContain(password);

      // Código errado: 400; certo: conta criada, sessão aberta, 10 códigos de recuperação mostrados uma vez.
      await post('/v1/admin/setup/confirm', { enrollmentId: view.enrollmentId, code: '000000' }).expect(400);
      const confirmed = await post('/v1/admin/setup/confirm', {
        enrollmentId: view.enrollmentId,
        code: await totpAt(view.secret, clock.now()),
      }).expect(200);
      const body = confirmed.body as { email: string; recoveryCodes: string[] };
      expect(body.email).toBe(OWNER);
      expect(body.recoveryCodes).toHaveLength(10);
      const id = sessionIdFrom(confirmed.headers['set-cookie']);
      expect(confirmed.body).not.toHaveProperty('sessionId');
      await me(sessionCookie(id ?? '')).expect(200, { email: OWNER });

      const accounts = await documents.query(COLLECTIONS.adminAccounts);
      expect(accounts).toHaveLength(1);
      const stored = JSON.stringify(accounts);
      for (const secret of [password, view.secret, ...body.recoveryCodes])
        expect(stored).not.toContain(secret);
      expect(stored).toContain('scrypt$15$8$3$');

      // Fechado: o mesmo cadastro não volta (410), e nenhum outro começa (409), nem de outro responsável.
      await request(app.getHttpServer()).get('/v1/admin/setup').expect(200, { open: false });
      await post('/v1/admin/setup/confirm', {
        enrollmentId: view.enrollmentId,
        code: await totpAt(view.secret, clock.now()),
      }).expect(410);
      const again = await post('/v1/admin/setup/start', {
        setupToken: secrets.setup,
        email: SECOND_OWNER,
        password: newPassword(),
      }).expect(409);
      expect(again.body).toMatchObject({ code: 'setup_closed' });
      expect(capture.entries().some((entry) => entry['event'] === 'admin_setup_completed')).toBe(true);
    });

    it('dois cadastros abertos ao mesmo tempo: só o primeiro a confirmar vale', async () => {
      const starts = await Promise.all(
        [OWNER, SECOND_OWNER].map(async (email) => {
          const response = await post('/v1/admin/setup/start', {
            setupToken: secrets.setup,
            email,
            password: newPassword(),
          }).expect(200);
          return response.body as { enrollmentId: string; secret: string };
        }),
      );
      const [first, second] = starts;
      await post('/v1/admin/setup/confirm', {
        enrollmentId: first?.enrollmentId,
        code: await totpAt(first?.secret ?? '', clock.now()),
      }).expect(200);
      const late = await post('/v1/admin/setup/confirm', {
        enrollmentId: second?.enrollmentId,
        code: await totpAt(second?.secret ?? '', clock.now()),
      }).expect(409);
      expect(late.body).toMatchObject({ code: 'setup_closed' });
      expect(await documents.query(COLLECTIONS.adminAccounts)).toHaveLength(1);
    });

    it('o cadastro pendente vence em 10 min; sem o token no cofre ou sem a chave, 503', async () => {
      const started = await post('/v1/admin/setup/start', {
        setupToken: secrets.setup,
        email: OWNER,
        password: newPassword(),
      }).expect(200);
      const view = started.body as { enrollmentId: string; secret: string };
      clock.advance(10 * MINUTE_MS);
      const expired = await post('/v1/admin/setup/confirm', {
        enrollmentId: view.enrollmentId,
        code: await totpAt(view.secret, clock.now()),
      }).expect(410);
      expect(expired.body).toMatchObject({ code: 'enrollment_expired' });

      const token = secrets.setup;
      secrets.setup = undefined;
      const noToken = await post('/v1/admin/setup/start', {
        setupToken: token,
        email: OWNER,
        password: newPassword(),
      }).expect(503);
      expect(noToken.body).toMatchObject({ code: 'admin_unavailable' });
      secrets.setup = token;
      secrets.failing = true;
      await post('/v1/admin/setup/start', {
        setupToken: token,
        email: OWNER,
        password: newPassword(),
      }).expect(503);
    });

    it('o cadastro tem limite por IP (10 em 15 min, 429)', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await post('/v1/admin/setup/start', {
          setupToken: 'x',
          email: OWNER,
          password: newPassword(),
        }).expect(403);
      }
      const limited = await post('/v1/admin/setup/start', {
        setupToken: 'x',
        email: OWNER,
        password: newPassword(),
      });
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });
  });

  describe('login', () => {
    it('senha e código certos: sessão nova (id novo a cada login) com o cookie __session endurecido', async () => {
      const owner = await enroll();
      nextStep();
      const first = await login(OWNER.toUpperCase(), owner.password, {
        code: await totpAt(owner.secret, clock.now()),
      }).expect(200);
      expect(first.body).toEqual({ email: OWNER });
      const cookieLine =
        ([] as string[])
          .concat(first.headers['set-cookie'] ?? [])
          .find((line) => !line.startsWith('__session=;')) ?? '';
      expect(cookieLine).toMatch(/^__session=[A-Za-z0-9_-]{43};/);
      expect(cookieLine).toContain('HttpOnly');
      expect(cookieLine).toContain('Secure');
      expect(cookieLine).toContain('SameSite=Strict');
      expect(cookieLine).toContain('Path=/');
      expect(cookieLine).toContain('Max-Age=43200');
      expect(cookieLine).not.toContain('Domain=');
      nextStep();
      const second = await login(OWNER, owner.password, {
        code: await totpAt(owner.secret, clock.now()),
      }).expect(200);
      const firstId = sessionIdFrom(first.headers['set-cookie']);
      const secondId = sessionIdFrom(second.headers['set-cookie']);
      expect(firstId).not.toBe(secondId);
      await me(sessionCookie(firstId ?? '')).expect(200);
      await me(sessionCookie(secondId ?? '')).expect(200);
      // No Firestore, só o SHA-256 do id.
      const sessions = await documents.query(COLLECTIONS.adminSessions);
      expect(sessions.map((doc) => doc.id)).toContain(opaqueRef(secondId ?? ''));
      expect(JSON.stringify(sessions)).not.toContain(secondId ?? '');
    });

    it('e-mail desconhecido, senha errada, código errado e código reusado: a mesma resposta, sem cookie', async () => {
      const owner = await enroll();
      const used = await totpAt(owner.secret, clock.now());
      nextStep();
      const right = await totpAt(owner.secret, clock.now());
      const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
      const attempts = [
        { email: 'ninguem@verax.example', password: owner.password, code: right },
        { email: STRANGER, password: owner.password, code: right },
        { email: OWNER, password: `${owner.password}x`, code: right },
        { email: OWNER, password: owner.password, code: wrong },
        // O código do cadastro (passo já aceito): reuso.
        { email: OWNER, password: owner.password, code: used },
      ];
      const bodies: unknown[] = [];
      for (const attempt of attempts) {
        const response = await post('/v1/admin/login', attempt).expect(401);
        expect(response.headers['set-cookie']).toBeUndefined();
        // Tudo igual menos o id da requisição (que é por requisição).
        const { requestId: _requestId, ...rest } = response.body as Record<string, unknown>;
        bodies.push(rest);
      }
      for (const body of bodies) {
        expect(body).toEqual({
          statusCode: 401,
          error: 'Unauthorized',
          message: LOGIN_FAILED_MESSAGE,
          code: 'login_failed',
        });
      }
      // Só a senha (sem segundo fator) não é login: 400, sem cookie, sem estado intermediário.
      const passwordOnly = await post('/v1/admin/login', { email: OWNER, password: owner.password }).expect(
        400,
      );
      expect(passwordOnly.headers['set-cookie']).toBeUndefined();
      // O motivo verdadeiro fica só no log interno.
      const reasons = capture
        .entries()
        .filter((entry) => entry['event'] === 'admin_auth_failed')
        .slice(-5)
        .map((entry) => entry['reason']);
      expect(reasons).toEqual([
        'unknown_account',
        'unknown_account',
        'bad_password',
        'bad_code',
        'replayed_code',
      ]);
    });

    it('o mesmo código não entra duas vezes, nem em duas requisições ao mesmo tempo', async () => {
      const owner = await enroll();
      nextStep();
      const code = await totpAt(owner.secret, clock.now());
      const results = await Promise.all([
        login(OWNER, owner.password, { code }),
        login(OWNER, owner.password, { code }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
      await login(OWNER, owner.password, { code }).expect(401);
    });

    it('senha errada não bloqueia a conta (o e-mail é público): só os limites de falhas por IP', async () => {
      const owner = await enroll();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        ip = `203.0.113.${attempt + 1}`;
        await login(OWNER, 'senha-errada-de-teste', { code: '000000' }).expect(401);
      }
      expect(capture.entries().some((entry) => entry['event'] === 'admin_account_locked')).toBe(false);
      expect(await documents.get(COLLECTIONS.adminLoginThrottle, throttleRef(OWNER))).toBeUndefined();
      nextStep();
      await login(OWNER, owner.password, { code: await totpAt(owner.secret, clock.now()) }).expect(200);
      // Nem um e-mail desconhecido grava contador.
      await login('ninguem@verax.example', 'senha-errada-de-teste', { code: '000000' }).expect(401);
      expect(
        await documents.get(COLLECTIONS.adminLoginThrottle, throttleRef('ninguem@verax.example')),
      ).toBeUndefined();
    });

    it('senha certa e código errado 5 vezes em 15 min bloqueiam por 15 min, mesmo com tudo certo depois', async () => {
      const owner = await enroll();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        ip = `203.0.113.${attempt + 1}`;
        await login(OWNER, owner.password, { code: '000000' }).expect(401);
      }
      expect(capture.entries().filter((entry) => entry['event'] === 'admin_account_locked')).toHaveLength(1);
      nextStep();
      const locked = await login(OWNER, owner.password, {
        code: await totpAt(owner.secret, clock.now()),
      }).expect(401);
      expect(locked.body).toMatchObject({ code: 'login_failed', message: LOGIN_FAILED_MESSAGE });
      // Passados os 15 min, entra; o contador some.
      clock.advance(15 * MINUTE_MS);
      await login(OWNER, owner.password, { code: await totpAt(owner.secret, clock.now()) }).expect(200);
      expect(await documents.get(COLLECTIONS.adminLoginThrottle, throttleRef(OWNER))).toBeUndefined();
    });

    it('palpites em paralelo do segundo fator: a tentativa é reservada antes, e só 5 chegam a ser conferidos', async () => {
      const owner = await enroll();
      const codes = Array.from({ length: 12 }, (_, index) => String(100_000 + index));
      const responses = await Promise.all(
        codes.map((code, index) => {
          ip = `203.0.113.${index + 1}`;
          return login(OWNER, owner.password, { code });
        }),
      );
      expect(responses.every((response) => response.status === 401)).toBe(true);
      const reasons = capture
        .entries()
        .filter((entry) => entry['event'] === 'admin_auth_failed')
        .slice(-12)
        .map((entry) => entry['reason']);
      expect(reasons.filter((reason) => reason === 'locked')).toHaveLength(7);
      expect(reasons.filter((reason) => reason !== 'locked')).toHaveLength(5);
    });

    it('limite por IP (10 falhas em 15 min): 429 com Retry-After; pedido malformado e login certo não contam', async () => {
      const owner = await enroll();
      // Corpo inválido: 400, sem gastar nada.
      for (let attempt = 0; attempt < 20; attempt += 1) await post('/v1/admin/login', {}).expect(400);
      for (let attempt = 0; attempt < 9; attempt += 1) {
        await login(`pessoa-${attempt}@verax.example`, 'x', { code: '000000' }).expect(401);
      }
      // O login certo devolve a tentativa: o balde continua com uma.
      nextStep();
      await login(OWNER, owner.password, { code: await totpAt(owner.secret, clock.now()) }).expect(200);
      await login('mais-uma@verax.example', 'x', { code: '000000' }).expect(401);
      const limited = await login('outra-mais@verax.example', 'x', { code: '000000' });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'rate_limited' });
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('teto global de 100 falhas em 15 min, de qualquer IP; pedido malformado não conta', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        ip = `192.0.2.${attempt + 1}`;
        await post('/v1/admin/login', { email: 'x' }).expect(400);
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        ip = `10.${Math.floor(attempt / 10)}.0.${(attempt % 10) + 1}`;
        await login(`pessoa-${attempt}@verax.example`, 'x', { code: '000000' }).expect(401);
      }
      ip = '192.0.2.200';
      await login('mais-uma@verax.example', 'x', { code: '000000' }).expect(429);
      clock.advance(15 * MINUTE_MS);
      // Cem scrypts de verdade: com a máquina ocupada, passa dos 30 s padrão.
    }, 180_000);

    it('login com a senha antiga não abre sessão se a senha foi trocada entre a conferência e o commit', async () => {
      const owner = await enroll();
      const [recovery = ''] = owner.recoveryCodes;
      // As transações do login com a senha certa: a reserva da tentativa (1) e a do sucesso (2).
      documents.before(2, () => changePasswordElsewhere());
      const response = await login(OWNER, owner.password, { recoveryCode: recovery }).expect(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(
        capture
          .entries()
          .filter((entry) => entry['event'] === 'admin_auth_failed')
          .at(-1),
      ).toMatchObject({
        event: 'admin_auth_failed',
        reason: 'stale_credentials',
      });
      // Nada gravado: nenhuma sessão nova e o código de recuperação continua sem uso.
      expect((await documents.query(COLLECTIONS.adminSessions)).length).toBe(1);
      const [account] = await documents.query(COLLECTIONS.adminAccounts);
      const codes = account?.data['recoveryCodes'] as { usedAt?: Date }[];
      expect(codes.every((entry) => entry.usedAt === undefined)).toBe(true);
    });

    it('código de recuperação: entra uma vez cada um, no lugar do código do aplicativo', async () => {
      const owner = await enroll();
      const [code = '', other = ''] = owner.recoveryCodes;
      await login(OWNER, owner.password, { recoveryCode: code.toLowerCase() }).expect(200);
      await login(OWNER, owner.password, { recoveryCode: code }).expect(401);
      // A senha continua exigida.
      await login(OWNER, 'senha-errada-de-teste', { recoveryCode: other }).expect(401);
      await login(OWNER, owner.password, { recoveryCode: other.replace('-', ' ') }).expect(200);
      const used = capture.entries().filter((entry) => entry['event'] === 'admin_recovery_code_used');
      expect(used.map((entry) => entry['left'])).toEqual([9, 8]);
    });

    it('sem a chave do cofre (vazio, fora do formato ou fora do ar), 503 para todo e-mail', async () => {
      const fresh = await createApp({
        role: 'admin',
        nodeEnv: 'test',
        documentStore: new MemoryDocumentStore(),
        clock,
        adminSecrets: Object.assign(new MemoryAdminSecrets(), { totp: 'curta' }),
        env: { ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo', OWNER_PRINCIPALS: OWNER },
      });
      try {
        const response = await request(fresh.getHttpServer())
          .post('/v1/admin/login')
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ email: OWNER, password: 'x', code: '123456' }))
          .expect(503);
        expect(response.body).toMatchObject({ code: 'admin_unavailable' });
      } finally {
        await fresh.close();
      }
    });
  });

  describe('cookies __session plantados por um site irmão', () => {
    it('todos os __session do cabeçalho são conferidos: o de verdade vale mesmo depois de vários plantados', async () => {
      const owner = await enroll();
      const planted = Array.from({ length: 15 }, () => sessionCookie(randomBytes(32).toString('base64url')));
      await me(`${planted.join('; ')}; ${owner.cookie}`).expect(200, { email: OWNER });
    });

    it('login, saída e sessão recusada apagam os __session com Domain da zona em /, /v1 e /v1/admin', async () => {
      const owner = await enroll();
      const domainClears = (lines: string[]): string[] =>
        lines
          .filter((line) => line.startsWith('__session=;') && line.includes('Domain=veraxsistemas.com.br'))
          .map((line) => /Path=([^;]+)/.exec(line)?.[1] ?? '')
          .sort();
      const asList = (value: string[] | string | undefined): string[] =>
        value === undefined ? [] : Array.isArray(value) ? value : [value];

      nextStep();
      const logged = await login(OWNER, owner.password, {
        code: await totpAt(owner.secret, clock.now()),
      }).expect(200);
      const loginCookies = asList(logged.headers['set-cookie']);
      expect(domainClears(loginCookies)).toEqual(['/', '/v1', '/v1/admin']);
      // O cookie novo continua só do host.
      expect(loginCookies.find((line) => /^__session=[A-Za-z0-9_-]{43};/.test(line))).not.toContain(
        'Domain=',
      );

      const refused = await me(sessionCookie(randomBytes(32).toString('base64url'))).expect(401);
      expect(domainClears(asList(refused.headers['set-cookie']))).toEqual(['/', '/v1', '/v1/admin']);

      const out = await post('/v1/admin/logout', {}, owner.cookie).expect(204);
      expect(domainClears(asList(out.headers['set-cookie']))).toEqual(['/', '/v1', '/v1/admin']);
    });
  });

  describe('sessão, saída e conta', () => {
    it('sair apaga a sessão no servidor: o mesmo cookie não serve mais', async () => {
      const owner = await enroll();
      await me(owner.cookie).expect(200);
      const out = await post('/v1/admin/logout', {}, owner.cookie).expect(204);
      expect(([] as string[]).concat(out.headers['set-cookie'] ?? []).join(';')).toMatch(/__session=;/);
      await me(owner.cookie).expect(401);
      expect(await documents.query(COLLECTIONS.adminSessions)).toHaveLength(0);
      // Sem sessão, a mesma resposta.
      await post('/v1/admin/logout', {}).expect(204);
      expect(capture.entries().some((entry) => entry['event'] === 'admin_logout')).toBe(true);
    });

    it('trocar a senha exige a senha atual e o código; as outras sessões caem', async () => {
      const owner = await enroll();
      nextStep();
      const other = await login(OWNER, owner.password, {
        code: await totpAt(owner.secret, clock.now()),
      }).expect(200);
      const otherCookie = sessionCookie(sessionIdFrom(other.headers['set-cookie']) ?? '');
      const replacement = newPassword();
      // Sem sessão: 401; código errado: 400 (a sessão continua).
      nextStep();
      await post('/v1/admin/account/password', {
        currentPassword: owner.password,
        code: await totpAt(owner.secret, clock.now()),
        newPassword: replacement,
      }).expect(401);
      const wrong = await post(
        '/v1/admin/account/password',
        { currentPassword: owner.password, code: '000000', newPassword: replacement },
        owner.cookie,
      ).expect(400);
      expect(wrong.body).toMatchObject({ code: 'invalid_credentials' });
      const short = await post(
        '/v1/admin/account/password',
        {
          currentPassword: owner.password,
          code: await totpAt(owner.secret, clock.now()),
          newPassword: 'curta',
        },
        owner.cookie,
      ).expect(400);
      expect(short.body).toMatchObject({ details: { issues: [{ path: 'newPassword' }] } });
      await post(
        '/v1/admin/account/password',
        {
          currentPassword: owner.password,
          code: await totpAt(owner.secret, clock.now()),
          newPassword: replacement,
        },
        owner.cookie,
      ).expect(204);
      await me(owner.cookie).expect(200);
      await me(otherCookie).expect(401);
      nextStep();
      await login(OWNER, owner.password, { code: await totpAt(owner.secret, clock.now()) }).expect(401);
      nextStep();
      await login(OWNER, replacement, { code: await totpAt(owner.secret, clock.now()) }).expect(200);
    });

    it('troca de senha conferida antes de outra troca de senha (outra sessão) não se completa', async () => {
      const owner = await enroll();
      nextStep();
      // A troca de senha: a reserva (1) e o commit (2); a senha muda em outra sessão entre os dois.
      documents.before(2, () => changePasswordElsewhere());
      await post(
        '/v1/admin/account/password',
        {
          currentPassword: owner.password,
          code: await totpAt(owner.secret, clock.now()),
          newPassword: newPassword(),
        },
        owner.cookie,
      ).expect(400);
      expect(
        capture
          .entries()
          .filter((entry) => entry['event'] === 'admin_auth_failed')
          .at(-1),
      ).toMatchObject({ reason: 'stale_credentials' });
    });

    it('troca do aplicativo começada, depois a senha trocada: o cadastro novo não vale mais', async () => {
      const owner = await enroll();
      const [recovery = ''] = owner.recoveryCodes;
      const started = await post(
        '/v1/admin/account/totp/start',
        { currentPassword: owner.password, recoveryCode: recovery },
        owner.cookie,
      ).expect(200);
      const view = started.body as { enrollmentId: string; secret: string };
      nextStep();
      const replacement = newPassword();
      await post(
        '/v1/admin/account/password',
        {
          currentPassword: owner.password,
          code: await totpAt(owner.secret, clock.now()),
          newPassword: replacement,
        },
        owner.cookie,
      ).expect(204);
      nextStep();
      await post(
        '/v1/admin/account/totp/confirm',
        { enrollmentId: view.enrollmentId, code: await totpAt(view.secret, clock.now()) },
        owner.cookie,
      ).expect(410);
      // O aplicativo de antes continua valendo, com a senha nova.
      nextStep();
      await login(OWNER, replacement, { code: await totpAt(owner.secret, clock.now()) }).expect(200);
    });

    it('trocar o aplicativo (celular perdido): com a senha e um código de recuperação; o antigo deixa de valer', async () => {
      const owner = await enroll();
      const [recovery = ''] = owner.recoveryCodes;
      const started = await post(
        '/v1/admin/account/totp/start',
        { currentPassword: owner.password, recoveryCode: recovery },
        owner.cookie,
      ).expect(200);
      const view = started.body as { enrollmentId: string; secret: string };
      expect(view.secret).not.toBe(owner.secret);
      // De outra sessão, o cadastro não se confirma.
      nextStep();
      const other = await login(OWNER, owner.password, {
        code: await totpAt(owner.secret, clock.now()),
      }).expect(200);
      const otherCookie = sessionCookie(sessionIdFrom(other.headers['set-cookie']) ?? '');
      await post(
        '/v1/admin/account/totp/confirm',
        { enrollmentId: view.enrollmentId, code: await totpAt(view.secret, clock.now()) },
        otherCookie,
      ).expect(410);
      const confirmed = await post(
        '/v1/admin/account/totp/confirm',
        { enrollmentId: view.enrollmentId, code: await totpAt(view.secret, clock.now()) },
        owner.cookie,
      ).expect(200);
      const codes = (confirmed.body as { recoveryCodes: string[] }).recoveryCodes;
      expect(codes).toHaveLength(10);
      await me(otherCookie).expect(401);
      nextStep();
      await login(OWNER, owner.password, { code: await totpAt(owner.secret, clock.now()) }).expect(401);
      await login(OWNER, owner.password, { recoveryCode: owner.recoveryCodes[1] ?? '' }).expect(401);
      await login(OWNER, owner.password, { code: await totpAt(view.secret, clock.now()) }).expect(200);
    });

    it('a auditoria registra as ações; nenhum log leva senha, código, token, segredo, id de sessão ou e-mail', async () => {
      const owner = await enroll();
      nextStep();
      const code = await totpAt(owner.secret, clock.now());
      const response = await login(OWNER, owner.password, { code }).expect(200);
      const id = sessionIdFrom(response.headers['set-cookie']) ?? '';
      await login(OWNER, 'senha-errada-de-teste', { code: '000000' }).expect(401);
      await post('/v1/admin/logout', {}, sessionCookie(id)).expect(204);

      const actions = (await documents.query(COLLECTIONS.auditLog, { orderBy: { field: 'at' } })).map(
        (doc) => [doc.data['actor'], doc.data['action']],
      );
      expect(actions).toEqual([
        [`owner:${OWNER}`, 'admin.setup'],
        [`owner:${OWNER}`, 'admin.login'],
        [`owner:${OWNER}`, 'admin.logout'],
      ]);
      const text = capture.text;
      for (const secret of [
        owner.password,
        owner.secret,
        code,
        id,
        secrets.setup ?? '',
        secrets.totp ?? '',
        ...owner.recoveryCodes,
        OWNER,
      ]) {
        expect(text, secret).not.toContain(secret);
      }
    });
  });
});
