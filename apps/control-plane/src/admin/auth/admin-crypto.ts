import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';

/**
 * As chaves do login do console, derivadas (HKDF-SHA256) da chave mestra do cofre `cp-admin-totp-key` (32 bytes ou
 * mais, em base64): uma para cifrar o segredo do TOTP no Firestore (AES-256-GCM) e outra para assinar os códigos de
 * recuperação (HMAC-SHA256). Quem lê o banco sem o cofre não tem o segredo do TOTP nem consegue testar códigos de
 * recuperação fora do ar. A chave mestra não pode ser trocada depois do cadastro: o segredo guardado deixaria de abrir
 * (o responsável refaz o cadastro, docs/runbooks/console-do-responsavel.md).
 */
export const MASTER_KEY_MIN_BYTES = 32;

const HKDF_SALT = Buffer.from('verax-control:cp-admin', 'utf8');
const TOTP_INFO = 'totp-secret:v1';
const RECOVERY_INFO = 'recovery-code:v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class AdminKeys {
  private constructor(
    private readonly totpKey: Buffer,
    private readonly recoveryKey: Buffer,
  ) {}

  /** A partir do conteúdo do cofre (base64 de 32 bytes ou mais); `undefined` fora do formato. */
  static fromSecret(value: string): AdminKeys | undefined {
    const text = value.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length > 512) return undefined;
    const master = Buffer.from(text, 'base64');
    if (master.length < MASTER_KEY_MIN_BYTES) return undefined;
    const derive = (info: string): Buffer =>
      Buffer.from(hkdfSync('sha256', master, HKDF_SALT, Buffer.from(info, 'utf8'), KEY_BYTES));
    return new AdminKeys(derive(TOTP_INFO), derive(RECOVERY_INFO));
  }

  /** Cifra o segredo do TOTP, preso (AAD) ao documento da conta: copiado para outra conta, não abre. */
  sealTotpSecret(secret: string, binding: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.totpKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(binding, 'utf8'));
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return {
      v: 1,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      data: data.toString('base64url'),
    };
  }

  /** O segredo do TOTP, ou `undefined` (outra chave mestra, documento adulterado ou de outra conta). */
  openTotpSecret(sealed: SealedSecret, binding: string): string | undefined {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.totpKey, Buffer.from(sealed.iv, 'base64url'), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(binding, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  /** A assinatura guardada de um código de recuperação já normalizado (`normalizeRecoveryCode`). */
  recoveryCodeDigest(normalized: string): string {
    return createHmac('sha256', this.recoveryKey).update(normalized, 'utf8').digest('base64url');
  }

  /** Comparação em tempo constante entre um código digitado (normalizado) e uma assinatura guardada. */
  matchesRecoveryCode(normalized: string, digest: string): boolean {
    const actual = Buffer.from(this.recoveryCodeDigest(normalized), 'utf8');
    const expected = Buffer.from(digest, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

export const sealedSecretSchema = z.strictObject({
  v: z.literal(1),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  data: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type SealedSecret = z.infer<typeof sealedSecretSchema>;

/**
 * Códigos de recuperação: 10 por cadastro, 10 caracteres de um alfabeto sem os parecidos (0/O, 1/I/L), em dois grupos
 * (`ABCDE-FGH23`): 31^10, cerca de 49 bits cada. Valem uma vez e só no lugar do código do aplicativo (a senha continua
 * exigida). Guardados só como HMAC com a chave do cofre.
 */
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_LENGTH = 10;

export function newRecoveryCode(): string {
  let code = '';
  while (code.length < RECOVERY_LENGTH) {
    // Rejeição dos bytes acima do maior múltiplo do alfabeto: sem viés de módulo.
    for (const byte of randomBytes(RECOVERY_LENGTH * 2)) {
      if (byte >= 248) continue;
      code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
      if (code.length === RECOVERY_LENGTH) break;
    }
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Maiúsculas, sem espaço nem hífen; `undefined` se sobrar caractere fora do alfabeto ou o tamanho não bater. */
export function normalizeRecoveryCode(value: string): string | undefined {
  const compact = value.toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== RECOVERY_LENGTH) return undefined;
  for (const char of compact) if (!RECOVERY_ALPHABET.includes(char)) return undefined;
  return compact;
}
