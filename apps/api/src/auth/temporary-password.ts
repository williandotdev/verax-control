import { randomInt } from 'node:crypto';
import { TEMPORARY_PASSWORD_HOURS, type TemporaryPassword } from '@verax/shared';
import { hashPassword } from 'better-auth/crypto';
import { requestContext } from '../common/context/request-context.js';
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
 * A senha temporária da conta venceu. Marca sem prazo não deveria existir; se existir, vale como vencida. Usada na
 * leitura da sessão e na criação dela (login e verificação do MFA).
 */
export function temporaryPasswordExpired(
  user: { mustChangePassword?: boolean | null; temporaryPasswordExpiresAt?: Date | string | null },
  now: number = Date.now(),
): boolean {
  if (user.mustChangePassword !== true) return false;
  const expiresAt = user.temporaryPasswordExpiresAt
    ? new Date(user.temporaryPasswordExpiresAt).getTime()
    : NaN;
  return !(expiresAt > now);
}

/**
 * Grava uma senha temporária nova para a conta: a anterior deixa de valer, as sessões abertas caem, e o bloqueio por
 * tentativas é zerado (quem estava bloqueado volta a entrar com a nova). Conta criada pelo antigo convite, ainda sem
 * senha, passa a ativa.
 *
 * Tudo numa transação só: senha, marca, sessões e bloqueio mudam juntos ou nada muda. Dentro de uma requisição de
 * escrita, é a transação do `AuditInterceptor`, então o registro de auditoria entra no mesmo commit; fora dela (o
 * bootstrap do nó), uma transação própria.
 */
export async function setTemporaryPassword(
  auth: Auth,
  prisma: PrismaService,
  user: { id: string; email: string },
  now: Date = new Date(),
): Promise<TemporaryPassword> {
  const password = generateTemporaryPassword();
  // Hasher padrão da biblioteca (scrypt), o mesmo que o login confere.
  const hash = await hashPassword(password);
  const context = await auth.$context;
  const accountId = context.generateId({ model: 'account' });
  if (accountId === false) throw new Error('O Better Auth precisa gerar os IDs das contas.');
  const expiresAt = temporaryPasswordExpiry(now);

  const apply = async (db: Prisma.TransactionClient): Promise<void> => {
    // Primeiro a linha do usuário: a trava serializa duas gerações simultâneas para a mesma conta, e a segunda já
    // encontra a conta de senha criada pela primeira (sem duas contas `credential`).
    await db.user.update({
      where: { id: user.id },
      data: { mustChangePassword: true, temporaryPasswordExpiresAt: expiresAt },
    });
    // Conta de senha (provider `credential`): troca o hash, ou cria a conta se ainda não houver (antigo convite).
    const updated = await db.account.updateMany({
      where: { userId: user.id, providerId: 'credential' },
      data: { password: hash },
    });
    if (updated.count === 0) {
      await db.account.create({
        data: {
          id: accountId,
          userId: user.id,
          providerId: 'credential',
          accountId: user.id,
          password: hash,
        },
      });
    }
    await db.user.updateMany({ where: { id: user.id, status: 'invited' }, data: { status: 'active' } });
    await db.session.deleteMany({ where: { userId: user.id } });
    await db.loginAttempt.deleteMany({ where: { email: user.email } });
  };
  const requestTransaction = requestContext.getStore()?.tx;
  if (requestTransaction) await apply(requestTransaction);
  else await prisma.$transaction(apply);
  return { temporaryPassword: password, expiresAt: expiresAt.toISOString() };
}
