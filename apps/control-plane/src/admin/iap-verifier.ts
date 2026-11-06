import { OAuth2Client } from 'google-auth-library';
import type { Clock } from '../common/clock.js';

/**
 * Verificação do JWT assinado pelo IAP (Identity-Aware Proxy) no console do responsável (`cp-admin`): o IAP fica na
 * frente do Cloud Run e só deixa passar quem tem `roles/iap.httpsResourceAccessor`; o app confere de novo (defesa em
 * profundidade) o cabeçalho `x-goog-iap-jwt-assertion`: ES256, emissor `https://cloud.google.com/iap`, `aud` igual a
 * `IAP_AUDIENCE` e o e-mail em `OWNER_PRINCIPALS`. A verificação da assinatura e dos prazos (`iat`, `exp`, com a folga
 * do `google-auth-library`) é a do `OAuth2Client.verifySignedJwtWithCertsAsync`; o app acrescenta a exigência do
 * algoritmo, o tamanho e a lista de responsáveis.
 *
 * As mensagens de erro da biblioteca repetem o token inteiro: nada delas vai a log nem à resposta, só o motivo.
 */
export const IAP_JWT_HEADER = 'x-goog-iap-jwt-assertion';
export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_ALGORITHM = 'ES256';

/** Um JWT do IAP tem algumas centenas de bytes; acima disso, nem se tenta decodificar. */
const MAX_ASSERTION_LENGTH = 4096;

/** Chaves públicas do IAP, por `kid` (PEM). */
export interface IapKeySource {
  /** As chaves conhecidas; `refresh` pede releitura (um `kid` novo depois de uma rotação de chave). */
  keys(refresh?: boolean): Promise<Readonly<Record<string, string>>>;
}

export const IAP_KEY_SOURCE = Symbol('IAP_KEY_SOURCE');
export const IAP_VERIFIER = Symbol('IAP_VERIFIER');

/** Por quanto tempo as chaves valem em cache, e o intervalo mínimo entre duas releituras pedidas por um `kid` novo. */
const KEYS_CACHE_MS = 60 * 60_000;
const KEYS_MIN_REFRESH_MS = 60_000;

/**
 * As chaves do Google (`https://www.gstatic.com/iap/verify/public_key`, pelo `getIapPublicKeysAsync` da biblioteca),
 * em cache por 1 h. Só em produção: os testes injetam um `IapKeySource` com uma chave ES256 gerada no teste.
 */
export class GoogleIapKeySource implements IapKeySource {
  private cached: { keys: Readonly<Record<string, string>>; at: number } | undefined;
  private readonly client = new OAuth2Client();

  constructor(private readonly clock: Clock) {}

  async keys(refresh = false): Promise<Readonly<Record<string, string>>> {
    const now = this.clock.now().getTime();
    const maxAge = refresh ? KEYS_MIN_REFRESH_MS : KEYS_CACHE_MS;
    if (this.cached !== undefined && now - this.cached.at < maxAge) return this.cached.keys;
    const { pubkeys } = await this.client.getIapPublicKeysAsync();
    this.cached = { keys: { ...pubkeys }, at: now };
    return this.cached.keys;
  }
}

export type IapFailure =
  'missing' | 'malformed' | 'algorithm' | 'unknown_key' | 'keys_unavailable' | 'invalid' | 'not_owner';

export type IapVerification = { ok: true; email: string } | { ok: false; reason: IapFailure };

/** Só letras, números, `-` e `_` (base64url sem preenchimento), sem regex sobre a entrada. */
function isBase64Url(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const alphanumeric =
      (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (!alphanumeric && code !== 0x2d && code !== 0x5f) return false;
  }
  return true;
}

function decodeHeader(segment: string): { alg?: unknown; kid?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export class IapJwtVerifier {
  private readonly client = new OAuth2Client();
  private readonly owners: ReadonlySet<string>;

  constructor(
    private readonly keySource: IapKeySource,
    private readonly audience: string,
    owners: readonly string[],
  ) {
    this.owners = new Set(owners.map((owner) => owner.toLowerCase()));
  }

  async verify(assertion: unknown): Promise<IapVerification> {
    if (typeof assertion !== 'string' || assertion === '') return { ok: false, reason: 'missing' };
    const parts = assertion.split('.');
    if (assertion.length > MAX_ASSERTION_LENGTH || parts.length !== 3 || !parts.every(isBase64Url)) {
      return { ok: false, reason: 'malformed' };
    }
    const header = decodeHeader(parts[0] ?? '');
    if (header === undefined) return { ok: false, reason: 'malformed' };
    if (header.alg !== IAP_ALGORITHM) return { ok: false, reason: 'algorithm' };
    if (typeof header.kid !== 'string' || header.kid === '') return { ok: false, reason: 'malformed' };

    let keys: Readonly<Record<string, string>>;
    try {
      keys = await this.keySource.keys();
      if (!Object.hasOwn(keys, header.kid)) keys = await this.keySource.keys(true);
    } catch {
      return { ok: false, reason: 'keys_unavailable' };
    }
    if (!Object.hasOwn(keys, header.kid)) return { ok: false, reason: 'unknown_key' };

    let email: unknown;
    try {
      const ticket = await this.client.verifySignedJwtWithCertsAsync(assertion, { ...keys }, this.audience, [
        IAP_ISSUER,
      ]);
      email = ticket.getPayload()?.email;
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (typeof email !== 'string' || !this.owners.has(email.toLowerCase()))
      return { ok: false, reason: 'not_owner' };
    return { ok: true, email: email.toLowerCase() };
  }
}
