import { generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { IAP_ISSUER, type IapKeySource } from '../../src/admin/iap-verifier.js';

/**
 * Um "IAP" de mentira para os testes do console: um par de chaves ES256 (P-256) gerado no teste, a chave pública em
 * PEM por `kid` (o formato de https://www.gstatic.com/iap/verify/public_key) e JWTs assinados com ela, no formato do
 * cabeçalho `x-goog-iap-jwt-assertion`. Nenhuma chave nem token fixo entra no repositório; nada fala com o Google.
 */
export class TestIap implements IapKeySource {
  readonly kid = `teste-${randomBytes(4).toString('hex')}`;
  private readonly privateKey: KeyObject;
  private readonly publicPem: string;
  /** Quantas vezes as chaves foram pedidas de novo (um `kid` desconhecido força a releitura). */
  refreshes = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  keys(refresh = false): Promise<Readonly<Record<string, string>>> {
    if (refresh) this.refreshes += 1;
    return Promise.resolve({ [this.kid]: this.publicPem });
  }

  /** Um JWT como o IAP mandaria; `header` e `payload` trocam o que o teste quiser estragar. */
  token(options: {
    audience: string;
    email: string;
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    signer?: KeyObject;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'ES256', typ: 'JWT', kid: this.kid, ...options.header };
    const payload = {
      iss: IAP_ISSUER,
      aud: options.audience,
      sub: 'accounts.google.com:111111111111111111111',
      email: options.email,
      iat: now,
      exp: now + 600,
      ...options.payload,
    };
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const signed = `${encode(header)}.${encode(payload)}`;
    const signature = sign('sha256', Buffer.from(signed), {
      key: options.signer ?? this.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return `${signed}.${signature}`;
  }

  /** Outra chave, que o "IAP" não conhece: o token assinado com ela tem a assinatura inválida. */
  static otherSigner(): KeyObject {
    return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  }
}
