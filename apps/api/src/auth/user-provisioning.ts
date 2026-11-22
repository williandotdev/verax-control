import { generateRandomString, hashPassword } from 'better-auth/crypto';
import { requestContext } from '../common/context/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
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
 * Invariante: o caminho transacional (`insertUser`, que o worker também usa para a conta pedida pelo console) grava
 * direto pelo Prisma, sem o `createWithHooks` do Better Auth. Por isso a configuração (e os plugins) não podem ter
 * `databaseHooks.user.create` nem `databaseHooks.account.create`: rodariam no seed e no bootstrap, mas não em
 * `POST /users`, em `POST /tenants` nem na conta pedida pelo console. O teste `user-provisioning.test.ts` falha se um
 * aparecer; se um hook desses for necessário um dia, este caminho precisa passar a chamá-lo.
 */
export async function provisionUser(auth: Auth, input: NewUser): Promise<{ id: string }> {
  const transaction = requestContext.getStore()?.tx;
  if (transaction) return insertUser(transaction, await authIds(auth), input);

  assertPasswordLength(input.password);
  const context = await auth.$context;
  // Hasher padrão da biblioteca (scrypt), o mesmo do login. A checagem de senha vazada vale nos caminhos em que o
  // próprio usuário escolhe a senha (redefinição e troca); aqui só entram o seed e os testes.
  const passwordHash = input.password === undefined ? undefined : await hashPassword(input.password);
  const created = await context.internalAdapter.createUser(userFields(input), { method: 'admin' });
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

/**
 * Os IDs das linhas do Better Auth que gravamos direto pelo Prisma (o usuário e a conta de senha). É só para isso que
 * estes caminhos precisam da instância do Better Auth.
 */
export interface AuthIds {
  generateId(model: 'user' | 'account'): string;
}

/** Os IDs do `$context.generateId` da configuração (a API, o seed, o bootstrap do nó). */
export async function authIds(auth: Auth): Promise<AuthIds> {
  const context = await auth.$context;
  return {
    generateId(model) {
      const id = context.generateId({ model });
      if (id === false) {
        throw new Error(
          model === 'user'
            ? 'O Better Auth precisa gerar os IDs dos usuários.'
            : 'O Better Auth precisa gerar os IDs das contas.',
        );
      }
      return id;
    },
  };
}

/**
 * Os IDs como o Better Auth 1.7 os gera, sem a instância (o worker, que não sobe a autenticação). A configuração não
 * define `advanced.generateId` nem `advanced.database.generateId`, e então o `$context.generateId` cai no `generateId`
 * padrão do `@better-auth/core` (32 caracteres de `a-z`, `A-Z` e `0-9`), que o pacote não exporta. É o mesmo sorteio
 * do `generateRandomString` de `better-auth/crypto` com esses alfabetos, nessa ordem. O teste
 * `user-provisioning.test.ts` falha se a configuração passar a definir outro gerador.
 */
export const defaultAuthIds: AuthIds = {
  generateId: () => generateRandomString(32, 'a-z', 'A-Z', '0-9'),
};

/**
 * Grava o usuário (e a conta de senha, quando há senha) numa transação já aberta, com os IDs dados: o caminho
 * transacional de `provisionUser` e o do worker, que cria a conta pedida pela Verax no console
 * (`control-plane-sync/apply-user.ts`). Grava direto pelo Prisma (a invariante está em `provisionUser`).
 */
export async function insertUser(
  db: Prisma.TransactionClient,
  ids: AuthIds,
  input: NewUser,
): Promise<{ id: string }> {
  assertPasswordLength(input.password);
  // Hasher padrão da biblioteca (scrypt), o mesmo do login.
  const passwordHash = input.password === undefined ? undefined : await hashPassword(input.password);
  const id = ids.generateId('user');
  await db.user.create({ data: { id, ...userFields(input) }, select: { id: true } });
  if (passwordHash !== undefined) {
    await db.account.create({
      data: {
        id: ids.generateId('account'),
        userId: id,
        providerId: 'credential',
        accountId: id,
        password: passwordHash,
      },
      select: { id: true },
    });
  }
  return { id };
}

function assertPasswordLength(password: string | undefined): void {
  if (
    password !== undefined &&
    (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH)
  ) {
    throw new Error(`A senha precisa ter entre ${PASSWORD_MIN_LENGTH} e ${PASSWORD_MAX_LENGTH} caracteres`);
  }
}

function userFields(input: NewUser) {
  return {
    email: input.email.trim().toLowerCase(),
    name: input.name,
    emailVerified: false,
    role: input.role,
    tenantId: input.tenantId,
    status: input.status,
  };
}
