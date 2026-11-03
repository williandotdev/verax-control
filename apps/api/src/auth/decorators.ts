import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Permission } from '@verax/shared';

export const IS_PUBLIC_KEY = 'verax:public';
export const SELF_MANAGED_KEY = 'verax:self-managed';
export const ALLOW_WITHOUT_MFA_KEY = 'verax:allow-without-mfa';
export const ALLOW_WITH_TEMPORARY_CREDENTIAL_KEY = 'verax:allow-with-temporary-password';

/** Rota acessível sem sessão. Toda rota sem este decorator exige login (negação por padrão). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Rota acessível por sessão que ainda não cadastrou o MFA (só a identidade, para o painel conduzir o
 * cadastro). Todas as outras exigem MFA ativo.
 */
export const AllowWithoutMfa = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);

/**
 * Rota acessível por sessão aberta com a senha temporária (só a identidade e o token CSRF, para o painel conduzir a
 * troca). Todas as outras exigem a senha definida pela própria pessoa.
 */
export const AllowWithTemporaryPassword = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WITH_TEMPORARY_CREDENTIAL_KEY, true);

/**
 * Rota que valida a própria entrada e grava a própria auditoria (hoje, só o handler do Better Auth). Fica
 * fora do interceptor de auditoria e do bloqueio de entrada não declarada. O meta-teste de rotas mantém a
 * lista dessas rotas fechada.
 */
export const SelfManaged = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata(SELF_MANAGED_KEY, reason);

export function isSelfManaged(reflector: Reflector, context: ExecutionContext): boolean {
  const reason = reflector.getAllAndOverride<string | undefined>(SELF_MANAGED_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  return reason !== undefined;
}

export const PERMISSIONS_KEY = 'verax:permissions';
export const AUTHENTICATED_KEY = 'verax:authenticated';

/**
 * Permissões exigidas pela rota (todas). Toda rota que exige sessão precisa declarar `@RequirePermission`
 * ou `@Authenticated`; sem declaração, a rota é negada (T2.4).
 */
export const RequirePermission = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions);

/** Rota liberada para qualquer usuário logado (ex.: a própria identidade), declarada explicitamente. */
export const Authenticated = (): MethodDecorator & ClassDecorator => SetMetadata(AUTHENTICATED_KEY, true);
