import { TEMPORARY_PASSWORD_HOURS, type TemporaryPassword } from '@verax/shared';
import { generateTemporaryPassword } from '@verax/vault-envelope';
import { hashPassword } from 'better-auth/crypto';
import { requestContext } from '../common/context/request-context.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './auth.constants.js';
import type { Auth } from './auth.factory.js';
import { type AuthIds, authIds } from './user-provisioning.js';

/**
 * Senha temporária (no lugar do convite por e-mail): o administrador cria a conta ou gera uma senha nova, ela aparece
 * uma vez para ele, e no primeiro login a pessoa troca a senha e cadastra o MFA. Nunca é gravada em texto nem relida:
 * só o hash, como qualquer senha.
 */

/**
 * A geradora (20 sorteios de 57 símbolos, em quatro grupos de cinco) mora no `@verax/vault-envelope`: o plano de
 * controle gera com ela a senha do usuário que a Verax cria no nó.
 */
export { generateTemporaryPassword };

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
  const prepared = await prepareTemporaryPassword(await authIds(auth), { now });
  const requestTransaction = requestContext.getStore()?.tx;
  if (requestTransaction) await writeTemporaryPassword(requestTransaction, user, prepared);
  else await prisma.$transaction((tx) => writeTemporaryPassword(tx, user, prepared));
  return { temporaryPassword: prepared.password, expiresAt: prepared.expiresAt.toISOString() };
}

/** A senha temporária pronta para gravar: o texto (mostrado uma vez), o hash, a validade e o ID da conta. */
export interface PreparedTemporaryPassword {
  password: string;
  hash: string;
  expiresAt: Date;
  /** O ID da conta de senha, se ela ainda não existir (conta do antigo convite, ou recém-criada sem senha). */
  accountId: string;
}

/**
 * Prepara a senha temporária, fora da transação (o hash é lento de propósito): a gerada aqui, com validade de
 * `TEMPORARY_PASSWORD_HOURS`, ou a dada (a do pedido do console, que o worker abriu do envelope) com a validade dada.
 */
export async function prepareTemporaryPassword(
  ids: AuthIds,
  options: { now?: Date; password?: string; expiresAt?: Date } = {},
): Promise<PreparedTemporaryPassword> {
  const preset = options.password;
  if (preset !== undefined && (preset.length < PASSWORD_MIN_LENGTH || preset.length > PASSWORD_MAX_LENGTH)) {
    throw new Error(`A senha precisa ter entre ${PASSWORD_MIN_LENGTH} e ${PASSWORD_MAX_LENGTH} caracteres`);
  }
  const password = preset ?? generateTemporaryPassword();
  // Hasher padrão da biblioteca (scrypt), o mesmo que o login confere.
  const hash = await hashPassword(password);
  const accountId = ids.generateId('account');
  const expiresAt = options.expiresAt ?? temporaryPasswordExpiry(options.now);
  return { password, hash, expiresAt, accountId };
}

/**
 * Grava a senha temporária preparada numa transação já aberta (o que `setTemporaryPassword` descreve): o caminho dele e
 * o do worker, que cria a conta pedida pela Verax no console (`control-plane-sync/apply-user.ts`).
 */
export async function writeTemporaryPassword(
  db: Prisma.TransactionClient,
  user: { id: string; email: string },
  prepared: PreparedTemporaryPassword,
): Promise<void> {
  // Primeiro a linha do usuário: a trava serializa duas gerações simultâneas para a mesma conta, e a segunda já
  // encontra a conta de senha criada pela primeira (sem duas contas `credential`).
  await db.user.update({
    where: { id: user.id },
    data: { mustChangePassword: true, temporaryPasswordExpiresAt: prepared.expiresAt },
  });
  // Conta de senha (provider `credential`): troca o hash, ou cria a conta se ainda não houver (antigo convite).
  const updated = await db.account.updateMany({
    where: { userId: user.id, providerId: 'credential' },
    data: { password: prepared.hash },
  });
  if (updated.count === 0) {
    await db.account.create({
      data: {
        id: prepared.accountId,
        userId: user.id,
        providerId: 'credential',
        accountId: user.id,
        password: prepared.hash,
      },
    });
  }
  await db.user.updateMany({ where: { id: user.id, status: 'invited' }, data: { status: 'active' } });
  await db.session.deleteMany({ where: { userId: user.id } });
  await db.loginAttempt.deleteMany({ where: { email: user.email } });
}
