import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import {
  accountRef,
  type AdminAccount,
  type AdminSession,
  newOpaqueId,
  normalizeEmail,
  opaqueRef,
  SESSION_ABSOLUTE_MS,
} from '../../src/admin/auth/admin-auth.schema.js';
import { type AdminSecretSource, SecretUnavailableError } from '../../src/admin/auth/admin-secrets.js';
import { SESSION_COOKIE_NAME } from '../../src/admin/auth/session-cookie.js';
import type { Clock } from '../../src/common/clock.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';

/**
 * O cofre do login do console em memória: a chave mestra (32 bytes aleatórios gerados no teste, nunca um valor fixo no
 * repositório). `failing` simula o Secret Manager fora do ar.
 */
export class MemoryAdminSecrets implements AdminSecretSource {
  totp: string | undefined = randomBytes(32).toString('base64');
  failing = false;
  reads = 0;

  totpKey(): Promise<string | undefined> {
    this.reads += 1;
    if (this.failing) return Promise.reject(new SecretUnavailableError());
    return Promise.resolve(this.totp);
  }
}

/** O código do aplicativo autenticador no instante do relógio do teste (o mesmo cálculo do celular). */
export function totpAt(secret: string, at: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
}

/** O cabeçalho `Cookie` com o id de uma sessão. */
export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE_NAME}=${id}`;
}

/** O id da sessão no `Set-Cookie` da resposta, ou `undefined`. */
export function sessionIdFrom(setCookie: string[] | string | undefined): string | undefined {
  const lines = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of lines) {
    const prefix = `${SESSION_COOKIE_NAME}=`;
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).split(';', 1)[0] ?? '';
    if (value !== '') return value;
  }
  return undefined;
}

/**
 * Uma sessão do console gravada direto no Firestore em memória, como o login gravaria, para os testes das telas e da
 * API que não são do login. A conta existe (com valores de enfeite: nenhum login passa por ela), porque a sessão sem
 * conta cai na primeira regravação do "visto por último". Devolve o cabeçalho `Cookie`.
 */
export async function seedOwnerSession(store: DocumentStore, clock: Clock, email: string): Promise<string> {
  const normalized = normalizeEmail(email);
  const now = clock.now();
  const id = newOpaqueId();
  const session: AdminSession = {
    email: normalized,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
  };
  const account: AdminAccount = {
    email: normalized,
    passwordHash: 'conta-de-teste-sem-senha',
    totp: {
      v: 1,
      iv: randomBytes(12).toString('base64url'),
      tag: randomBytes(16).toString('base64url'),
      data: randomBytes(20).toString('base64url'),
    },
    lastTotpStep: 0,
    recoveryCodes: [],
    createdAt: now,
    updatedAt: now,
    passwordChangedAt: now,
    totpChangedAt: now,
  };
  await store.runTransaction(async (tx) => {
    const existing = await tx.get(COLLECTIONS.adminAccounts, accountRef(normalized));
    if (existing === undefined) tx.set(COLLECTIONS.adminAccounts, accountRef(normalized), account);
    tx.set(COLLECTIONS.adminSessions, opaqueRef(id), session);
  });
  return sessionCookie(id);
}
