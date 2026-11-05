import { createHash } from 'node:crypto';

/**
 * Link assinado V4 do Cloud Storage (https://docs.cloud.google.com/storage/docs/access-control/signing-urls-manually),
 * montado aqui e assinado fora (`signBlob` da conta de serviço, sem chave nenhuma no plano de controle). O link é a
 * credencial: quem o tem faz só o pedido assinado (o método, o objeto e o prazo), com as permissões da conta que
 * assinou. Nunca vai a log nem ao Firestore.
 */
export interface SignedUrlRequest {
  method: 'GET' | 'HEAD';
  /** `https://storage.googleapis.com` em produção; o servidor falso nos testes (com o caminho dele). */
  base: string;
  bucket: string;
  object: string;
  /** O e-mail da conta que assina (`X-Goog-Credential`). */
  signer: string;
  now: Date;
  /** Validade em segundos (o V4 aceita até 7 dias). */
  expiresSeconds: number;
}

export interface SignedUrlParts {
  /** O link sem a assinatura (`X-Goog-Signature` entra no fim). */
  unsignedUrl: string;
  canonicalRequest: string;
  stringToSign: string;
}

const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

/** RFC 3986: o `encodeURIComponent` mais `! ' ( ) *`, como a assinatura do Google pede. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function timestampOf(now: Date): { timestamp: string; date: string } {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.[0-9]{3}/, '');
  return { timestamp: iso, date: iso.slice(0, 8) };
}

/** As partes do link V4 (o pedido canônico e o texto a assinar). */
export function signedUrlParts(request: SignedUrlRequest): SignedUrlParts {
  if (!BUCKET_PATTERN.test(request.bucket)) throw new TypeError('bucket inválido');
  if (request.object === '' || request.object.startsWith('/') || request.object.includes('..')) {
    throw new TypeError('objeto inválido');
  }
  if (
    !Number.isInteger(request.expiresSeconds) ||
    request.expiresSeconds < 1 ||
    request.expiresSeconds > MAX_EXPIRES_SECONDS
  ) {
    throw new TypeError('validade fora da faixa');
  }
  const base = new URL(request.base);
  const prefix = base.pathname.replace(/\/+$/, '');
  const { timestamp, date } = timestampOf(request.now);
  const scope = `${date}/auto/storage/goog4_request`;
  const uri = `${prefix}/${request.bucket}/${request.object.split('/').map(encodeRfc3986).join('/')}`;
  const query = [
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', `${request.signer}/${scope}`],
    ['X-Goog-Date', timestamp],
    ['X-Goog-Expires', String(request.expiresSeconds)],
    ['X-Goog-SignedHeaders', 'host'],
  ]
    .sort(([a], [b]) => ((a ?? '') < (b ?? '') ? -1 : 1))
    .map(([key, value]) => `${encodeRfc3986(key ?? '')}=${encodeRfc3986(value ?? '')}`)
    .join('&');
  const canonicalRequest = [
    request.method,
    uri,
    query,
    `host:${base.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'GOOG4-RSA-SHA256',
    timestamp,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  return { unsignedUrl: `${base.origin}${uri}?${query}`, canonicalRequest, stringToSign };
}

/** O link assinado: `sign` assina o texto com RSA SHA-256 (o `signBlob` da conta). */
export async function signedUrl(
  request: SignedUrlRequest,
  sign: (payload: Buffer) => Promise<Buffer>,
): Promise<string> {
  const parts = signedUrlParts(request);
  const signature = await sign(Buffer.from(parts.stringToSign, 'utf8'));
  return `${parts.unsignedUrl}&X-Goog-Signature=${signature.toString('hex')}`;
}
