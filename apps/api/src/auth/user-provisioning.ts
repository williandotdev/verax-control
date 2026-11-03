import { hashPassword } from 'better-auth/crypto';
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
 * Cria um usuário pelo adaptador interno do Better Auth, com o hash de senha da própria biblioteca.
 * É o único caminho de criação: o cadastro público está desligado.
 */
export async function provisionUser(auth: Auth, input: NewUser): Promise<{ id: string }> {
  if (
    input.password !== undefined &&
    (input.password.length < PASSWORD_MIN_LENGTH || input.password.length > PASSWORD_MAX_LENGTH)
  ) {
    throw new Error(`A senha precisa ter entre ${PASSWORD_MIN_LENGTH} e ${PASSWORD_MAX_LENGTH} caracteres`);
  }
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    {
      email: input.email.trim().toLowerCase(),
      name: input.name,
      emailVerified: false,
      role: input.role,
      tenantId: input.tenantId,
      status: input.status,
    },
    { method: 'admin' },
  );
  if (input.password !== undefined) {
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      // Hasher padrão da biblioteca (scrypt), o mesmo do login. A checagem de senha vazada vale nos caminhos em
      // que o próprio usuário escolhe a senha (redefinição e troca); aqui só entram o seed e os testes.
      password: await hashPassword(input.password),
    });
  }
  return { id: user.id };
}
