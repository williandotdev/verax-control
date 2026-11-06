import { hashPassword } from 'better-auth/crypto';
import { requestContext } from '../common/context/request-context.js';
import type { UserRole, UserStatus } from '../generated/prisma/enums.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './auth.constants.js';
import type { Auth } from './auth.factory.js';

export interface NewUser {
  email: string;
  name: string;
  role: UserRole;
  tenantId: string | null;
  status: UserStatus;
  /** Sem senha, o usuário só entra depois de receber uma senha temporária (`temporary-password.ts`). */
  password?: string;
}

/**
 * Cria um usuário com os IDs e o hash de senha do próprio Better Auth. É o único caminho de criação: o cadastro
 * público está desligado.
 *
 * Dentro de uma requisição de escrita, a conta entra na transação do `AuditInterceptor` (o adaptador do Better Auth
 * grava pelo cliente base, fora dela): se a requisição falhar, a conta não fica, e um cliente criado na mesma
 * requisição pode ser referenciado antes do commit. Fora dela (seed, bootstrap do nó, testes), pelo adaptador interno
 * da biblioteca.
 *
 * Invariante: o caminho transacional grava direto pelo Prisma, sem o `createWithHooks` do Better Auth. Por isso a
 * configuração (e os plugins) não podem ter `databaseHooks.user.create` nem `databaseHooks.account.create`: rodariam
 * no seed e no bootstrap, mas não em `POST /users` nem em `POST /tenants`. O teste `user-provisioning.test.ts` falha
 * se um aparecer; se um hook desses for necessário um dia, este caminho precisa passar a chamá-lo.
 */
export async function provisionUser(auth: Auth, input: NewUser): Promise<{ id: string }> {
  if (
    input.password !== undefined &&
    (input.password.length < PASSWORD_MIN_LENGTH || input.password.length > PASSWORD_MAX_LENGTH)
  ) {
    throw new Error(`A senha precisa ter entre ${PASSWORD_MIN_LENGTH} e ${PASSWORD_MAX_LENGTH} caracteres`);
  }
  const context = await auth.$context;
  const user = {
    email: input.email.trim().toLowerCase(),
    name: input.name,
    emailVerified: false,
    role: input.role,
    tenantId: input.tenantId,
    status: input.status,
  };
  // Hasher padrão da biblioteca (scrypt), o mesmo do login. A checagem de senha vazada vale nos caminhos em que o
  // próprio usuário escolhe a senha (redefinição e troca); aqui só entram o seed e os testes.
  const passwordHash = input.password === undefined ? undefined : await hashPassword(input.password);

  const transaction = requestContext.getStore()?.tx;
  if (transaction) {
    const id = context.generateId({ model: 'user' });
    if (id === false) throw new Error('O Better Auth precisa gerar os IDs dos usuários.');
    await transaction.user.create({ data: { id, ...user }, select: { id: true } });
    if (passwordHash !== undefined) {
      const accountId = context.generateId({ model: 'account' });
      if (accountId === false) throw new Error('O Better Auth precisa gerar os IDs das contas.');
      await transaction.account.create({
        data: { id: accountId, userId: id, providerId: 'credential', accountId: id, password: passwordHash },
        select: { id: true },
      });
    }
    return { id };
  }

  const created = await context.internalAdapter.createUser(user, { method: 'admin' });
  if (passwordHash !== undefined) {
    await context.internalAdapter.linkAccount({
      userId: created.id,
      providerId: 'credential',
      accountId: created.id,
      password: passwordHash,
    });
  }
  return { id: created.id };
}
