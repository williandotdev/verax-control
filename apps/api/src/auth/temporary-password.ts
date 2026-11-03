import { randomInt } from 'node:crypto';
import { TEMPORARY_PASSWORD_HOURS, type TemporaryPassword } from '@verax/shared';
import { hashPassword } from 'better-auth/crypto';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Auth } from './auth.factory.js';

/**
 * Senha temporária (no lugar do convite por e-mail): o administrador cria a conta ou gera uma senha nova, ela aparece
 * uma vez para ele, e no primeiro login a pessoa troca a senha e cadastra o MFA. Nunca é gravada em texto nem relida:
 * só o hash, como qualquer senha.
 */

/** Sem os caracteres que se confundem ao ler ou ditar (0/O, 1/l/I). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const LENGTH = 20;

/** 20 sorteios de 57 símbolos (cerca de 116 bits), em quatro grupos de cinco para ler e ditar. */
export function generateTemporaryPassword(): string {
  const chars = Array.from({ length: LENGTH }, () => ALPHABET.charAt(randomInt(ALPHABET.length)));
  return [0, 5, 10, 15].map((start) => chars.slice(start, start + 5).join('')).join('-');
}

export function temporaryPasswordExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + TEMPORARY_PASSWORD_HOURS * 60 * 60 * 1000);
}

/**
 * Grava uma senha temporária nova para a conta: a anterior deixa de valer, as sessões abertas caem, e o bloqueio por
 * tentativas é zerado (quem estava bloqueado volta a entrar com a nova). Conta criada pelo antigo convite, ainda sem
 * senha, passa a ativa.
 */
export async function setTemporaryPassword(
  auth: Auth,
  prisma: PrismaService,
  user: { id: string; email: string },
  now: Date = new Date(),
): Promise<TemporaryPassword> {
  const password = generateTemporaryPassword();
  const hash = await hashPassword(password);
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(user.id);
  if (accounts.some((account) => account.providerId === 'credential')) {
    await context.internalAdapter.updatePassword(user.id, hash);
  } else {
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: hash,
    });
  }
  const expiresAt = temporaryPasswordExpiry(now);
  const data: Prisma.UserUpdateInput = { mustChangePassword: true, temporaryPasswordExpiresAt: expiresAt };
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data }),
    prisma.user.updateMany({ where: { id: user.id, status: 'invited' }, data: { status: 'active' } }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
    prisma.loginAttempt.deleteMany({ where: { email: user.email } }),
  ]);
  return { temporaryPassword: password, expiresAt: expiresAt.toISOString() };
}
