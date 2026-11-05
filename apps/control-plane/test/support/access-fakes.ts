import { generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import type { PinoLogger } from 'nestjs-pino';
import {
  AlreadyRevealedError,
  RevealNotAvailableError,
  StatusAccessNotFoundError,
} from '../../src/access/access-store.js';
import {
  type BootstrapCredentials,
  type BootstrapSecrets,
  BootstrapUnavailableError,
  parseBootstrapPayload,
} from '../../src/access/bootstrap-secrets.js';
import { PasswordExpiredError, type RevealService } from '../../src/access/reveal.service.js';
import type { IdTokenKeySource } from '../../src/internal/identity-token.js';
import type { MailMessage, MailSender } from '../../src/mail/mail-sender.js';
import {
  type RevealedAccessView,
  type RevealGateway,
  RevealGatewayError,
  type RevealRequest,
} from '../../src/status/reveal-gateway.js';

/** Senha temporária gerada no teste (nenhum valor fixo entra no repositório), no tamanho da do nó (20+ caracteres). */
export function fakeTemporaryPassword(): string {
  return `Tmp-${randomBytes(15).toString('base64url')}`;
}

interface StoredVersion {
  payload: string;
  state: 'ENABLED' | 'DESTROYED';
}

/** Uma porta: a próxima chamada para nela até o teste soltar (para provar a ordem dos efeitos). */
interface Gate {
  reached: () => void;
  released: Promise<void>;
}

/**
 * Dublê do `admin-bootstrap` de cada tenant: versões em memória, a `latest` lida pelo mesmo `parseBootstrapPayload`
 * da produção (com a máscara do logger) e a destruição que marca as versões como `DESTROYED`.
 */
export class MemoryBootstrapSecrets implements BootstrapSecrets {
  readonly versions = new Map<string, StoredVersion[]>();
  reads = 0;
  private failure: Error | undefined;
  private gate: Gate | undefined;

  put(slug: string, credentials: { email: string; password: string; expiresAt: Date }): void {
    this.putRaw(
      slug,
      JSON.stringify({
        email: credentials.email,
        password: credentials.password,
        expiresAt: credentials.expiresAt.toISOString(),
      }),
    );
  }

  putRaw(slug: string, payload: string): void {
    const list = this.versions.get(slug) ?? [];
    list.push({ payload, state: 'ENABLED' });
    this.versions.set(slug, list);
  }

  /** A próxima leitura falha com este erro (uma vez). */
  failNextRead(error: Error): void {
    this.failure = error;
  }

  /** A próxima leitura espera o teste: `reached` resolve quando ela começa; `release` a deixa seguir. */
  hold(): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { reached, released };
    return { reached: reachedPromise, release };
  }

  liveVersions(slug: string): number {
    return (this.versions.get(slug) ?? []).filter((version) => version.state === 'ENABLED').length;
  }

  async readLatest(slug: string): Promise<BootstrapCredentials> {
    this.reads += 1;
    const gate = this.gate;
    if (gate !== undefined) {
      this.gate = undefined;
      gate.reached();
      await gate.released;
    }
    const failure = this.failure;
    if (failure !== undefined) {
      this.failure = undefined;
      throw failure;
    }
    const latest = (this.versions.get(slug) ?? []).filter((version) => version.state === 'ENABLED').at(-1);
    if (latest === undefined) throw new BootstrapUnavailableError('not_found');
    return parseBootstrapPayload(latest.payload);
  }

  destroyAll(slug: string): Promise<number> {
    let destroyed = 0;
    for (const version of this.versions.get(slug) ?? []) {
      if (version.state === 'DESTROYED') continue;
      version.state = 'DESTROYED';
      destroyed += 1;
    }
    return Promise.resolve(destroyed);
  }
}

/** Dublê do envio de e-mail: guarda cada mensagem e pode falhar a próxima. */
export class MemoryMailSender implements MailSender {
  readonly sent: MailMessage[] = [];
  private failure: Error | undefined;

  failNext(error: Error): void {
    this.failure = error;
  }

  send(message: MailMessage): Promise<void> {
    const failure = this.failure;
    if (failure !== undefined) {
      this.failure = undefined;
      return Promise.reject(failure);
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Um token de identidade do Google como o Cloud Run o entrega no `X-Serverless-Authorization`, depois de conferi-lo
 * na entrada: as declarações em claro e a assinatura removida. Montado no teste, nunca um token real.
 */
export function fakeIdentityToken(claims: {
  email: string;
  aud: string;
  exp: number;
  iss?: string;
  emailVerified?: boolean;
}): string {
  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const payload = base64url({
    iss: claims.iss ?? 'https://accounts.google.com',
    aud: claims.aud,
    email: claims.email,
    email_verified: claims.emailVerified ?? true,
    exp: claims.exp,
    iat: claims.exp - 3600,
    sub: '000000000000000000000',
  });
  return `${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`;
}

/**
 * Um "Google" de mentira para os tokens de identidade das rotas internas: um par RSA gerado no teste, a chave pública
 * em PEM por `kid` (o formato dos certificados de https://www.googleapis.com/oauth2/v1/certs) e tokens RS256
 * assinados com ela, como os das tasks, do Scheduler e do cp-public. Os prazos usam o relógio do sistema, que é o que a
 * `google-auth-library` confere. Nenhuma chave nem token fixo entra no repositório; nada fala com o Google.
 */
export class TestGoogleIdentity implements IdTokenKeySource {
  readonly kid = `teste-${randomBytes(4).toString('hex')}`;
  private readonly privateKey: KeyObject;
  private readonly publicPem: string;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  keys(): Promise<Readonly<Record<string, string>>> {
    return Promise.resolve({ [this.kid]: this.publicPem });
  }

  /** Um token assinado; `payload` troca o que o teste quiser estragar; `signer` assina com outra chave. */
  token(options: {
    email: string;
    aud: string;
    payload?: Record<string, unknown>;
    header?: Record<string, unknown>;
    signer?: KeyObject;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    const signed = `${base64url({ alg: 'RS256', typ: 'JWT', kid: this.kid, ...options.header })}.${base64url({
      iss: 'https://accounts.google.com',
      aud: options.aud,
      email: options.email,
      email_verified: true,
      sub: '000000000000000000000',
      iat: now,
      exp: now + 3600,
      ...options.payload,
    })}`;
    const signature = sign('sha256', Buffer.from(signed), options.signer ?? this.privateKey).toString(
      'base64url',
    );
    return `${signed}.${signature}`;
  }

  /** Outra chave, que o "Google" não conhece: o token assinado com ela tem a assinatura inválida. */
  static otherSigner(): KeyObject {
    return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  }
}

/** Um logger que não escreve nada, para os serviços montados à mão fora de um app Nest. */
export function silentLogger(): PinoLogger {
  const noop = (): void => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  } as unknown as PinoLogger;
}

/**
 * O caminho do cp-public até a revelação sem HTTP: chama o `RevealService` do worker e traduz os erros nos mesmos
 * códigos que o `WorkerRevealGateway` devolve (o par controlador do worker + cliente HTTP é testado à parte). Pode
 * falhar a resposta depois de a revelação terminar no worker, como uma conexão que cai no caminho.
 */
export class InProcessRevealGateway implements RevealGateway {
  calls = 0;
  private dropNextResponse = false;

  constructor(private readonly reveals: () => RevealService) {}

  /** A próxima revelação termina no worker, mas a resposta não chega ao cp-public. */
  loseNextResponse(): void {
    this.dropNextResponse = true;
  }

  async reveal(request: RevealRequest): Promise<RevealedAccessView> {
    this.calls += 1;
    try {
      const revealed = await this.reveals().reveal(request.kind, request.token, {
        requestId: request.requestId,
      });
      if (this.dropNextResponse) {
        this.dropNextResponse = false;
        throw new Error('conexão com o cp-worker caiu antes da resposta');
      }
      return {
        panelUrl: revealed.panelUrl,
        adminEmail: revealed.adminEmail,
        password: revealed.password,
        passwordExpiresAt: revealed.passwordExpiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof StatusAccessNotFoundError) throw new RevealGatewayError('not_found');
      if (error instanceof AlreadyRevealedError) throw new RevealGatewayError('already_revealed');
      if (error instanceof RevealNotAvailableError) throw new RevealGatewayError('reveal_not_available');
      if (error instanceof PasswordExpiredError) throw new RevealGatewayError('password_expired');
      throw error;
    }
  }
}
