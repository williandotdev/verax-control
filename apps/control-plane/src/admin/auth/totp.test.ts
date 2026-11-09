import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { newTotpSecret, TOTP_ISSUER, totpUri, verifyTotp } from './totp.js';

const NOW = new Date('2026-11-04T12:00:10.000Z');
const STEP = Math.floor(NOW.getTime() / 1000 / 30);

function codeAt(secret: string, at: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
}

describe('TOTP do console', () => {
  it('segredo de 160 bits em base32 e o otpauth:// com o emissor e a conta', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(newTotpSecret()).not.toBe(secret);
    const uri = totpUri(secret, 'responsavel@verax.example');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(decodeURIComponent(uri)).toContain(TOTP_ISSUER);
    expect(decodeURIComponent(uri)).toContain('responsavel@verax.example');
  });

  it('aceita o código do passo atual e de um passo de cada lado; devolve o passo', async () => {
    const secret = newTotpSecret();
    await expect(verifyTotp(secret, await codeAt(secret, NOW), NOW)).resolves.toBe(STEP);
    const before = new Date(NOW.getTime() - 30_000);
    const after = new Date(NOW.getTime() + 30_000);
    await expect(verifyTotp(secret, await codeAt(secret, before), NOW)).resolves.toBe(STEP - 1);
    await expect(verifyTotp(secret, await codeAt(secret, after), NOW)).resolves.toBe(STEP + 1);
    const old = new Date(NOW.getTime() - 120_000);
    await expect(verifyTotp(secret, await codeAt(secret, old), NOW)).resolves.toBeUndefined();
  });

  it('reuso: o código de um passo igual ou anterior ao último aceito é recusado', async () => {
    const secret = newTotpSecret();
    const code = await codeAt(secret, NOW);
    const step = await verifyTotp(secret, code, NOW);
    expect(step).toBe(STEP);
    await expect(verifyTotp(secret, code, NOW, step)).resolves.toBeUndefined();
    const previous = await codeAt(secret, new Date(NOW.getTime() - 30_000));
    await expect(verifyTotp(secret, previous, NOW, step)).resolves.toBeUndefined();
    // O próximo passo continua valendo.
    const next = new Date(NOW.getTime() + 30_000);
    await expect(verifyTotp(secret, await codeAt(secret, next), next, step)).resolves.toBe(STEP + 1);
  });

  it('código errado, de outro segredo ou fora do formato: recusado sem exceção', async () => {
    const secret = newTotpSecret();
    const right = await codeAt(secret, NOW);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
    await expect(verifyTotp(secret, wrong, NOW)).resolves.toBeUndefined();
    await expect(verifyTotp(newTotpSecret(), right, NOW)).resolves.toBeUndefined();
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456', '12 456']) {
      await expect(verifyTotp(secret, bad, NOW), bad).resolves.toBeUndefined();
    }
  });
});
