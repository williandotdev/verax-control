import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

export const IS_PUBLIC_KEY = 'verax:public';
export const SELF_MANAGED_KEY = 'verax:self-managed';

/** Rota acessível sem sessão. Toda rota sem este decorator exige login (negação por padrão). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

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
