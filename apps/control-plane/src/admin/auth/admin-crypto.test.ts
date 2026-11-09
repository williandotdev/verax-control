import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AdminKeys,
  newRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  sealedSecretSchema,
} from './admin-crypto.js';

function keys(): AdminKeys {
  const value = AdminKeys.fromSecret(randomBytes(32).toString('base64'));
  if (value === undefined) throw new Error('chave de teste recusada');
  return value;
}

describe('chaves do login do console', () => {
  it('a chave mestra precisa ser base64 de 32 bytes ou mais (com ou sem quebra de linha no fim)', () => {
    expect(AdminKeys.fromSecret(randomBytes(32).toString('base64'))).toBeDefined();
    expect(AdminKeys.fromSecret(`${randomBytes(48).toString('base64')}\n`)).toBeDefined();
    expect(AdminKeys.fromSecret(randomBytes(16).toString('base64'))).toBeUndefined();
    expect(AdminKeys.fromSecret('não é base64 nenhum!')).toBeUndefined();
    expect(AdminKeys.fromSecret('')).toBeUndefined();
  });

  it('o segredo do TOTP sai cifrado (AES-256-GCM) e só abre com a mesma chave e a mesma conta', () => {
    const first = keys();
    const sealed = first.sealTotpSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'adminAccounts/a');
    expect(sealedSecretSchema.parse(sealed)).toEqual(sealed);
    expect(JSON.stringify(sealed)).not.toContain('JBSWY3DP');
    expect(first.openTotpSecret(sealed, 'adminAccounts/a')).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    // Outra conta (AAD), outra chave ou um byte trocado: não abre.
    expect(first.openTotpSecret(sealed, 'adminAccounts/b')).toBeUndefined();
    expect(keys().openTotpSecret(sealed, 'adminAccounts/a')).toBeUndefined();
    const flipped = sealed.data.startsWith('A') ? `B${sealed.data.slice(1)}` : `A${sealed.data.slice(1)}`;
    expect(first.openTotpSecret({ ...sealed, data: flipped }, 'adminAccounts/a')).toBeUndefined();
    // Cada cifragem com um IV novo.
    expect(first.sealTotpSecret('JBSWY3DPEHPK3PXP', 'x').iv).not.toBe(
      first.sealTotpSecret('JBSWY3DPEHPK3PXP', 'x').iv,
    );
  });

  it('os códigos de recuperação: formato, normalização e assinatura só com a chave', () => {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    const [code = ''] = codes;
    const normalized = normalizeRecoveryCode(code);
    expect(normalized).toBe(code.replace('-', ''));
    expect(normalizeRecoveryCode(` ${code.toLowerCase().replace('-', ' ')} `)).toBe(normalized);
    expect(normalizeRecoveryCode('ABCDE-FGHI0')).toBeUndefined();
    expect(normalizeRecoveryCode('ABCDE')).toBeUndefined();

    const k = keys();
    const digest = k.recoveryCodeDigest(normalized ?? '');
    expect(digest).not.toContain(normalized ?? '');
    expect(k.matchesRecoveryCode(normalized ?? '', digest)).toBe(true);
    expect(k.matchesRecoveryCode('ABCDEFGHJK', digest)).toBe(false);
    // Outra chave não reconhece a assinatura (quem lê o banco sem o cofre não testa códigos).
    expect(keys().matchesRecoveryCode(normalized ?? '', digest)).toBe(false);
  });
});
