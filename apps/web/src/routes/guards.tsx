import type { Permission } from '@verax/shared';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { useMe } from '@/features/session/session';
import { ApiRequestError } from '@/lib/api-client';

/**
 * Exige sessão com MFA para as rotas internas: quem entrou com a senha temporária vai antes trocar a senha, e quem
 * ainda não tem MFA vai cadastrá-lo. É só experiência de uso: quem decide o acesso é sempre a API (sessão, senha
 * temporária, MFA e permissão em cada requisição).
 */
export function RequireSession() {
  const location = useLocation();
  const me = useMe();

  if (me.isPending) return <LoadingState className="m-8" label="Abrindo o painel" />;
  if (me.error) {
    if (me.error instanceof ApiRequestError && me.error.status === 401) {
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return <ErrorState className="m-8" error={me.error} onRetry={() => void me.refetch()} />;
  }
  if (me.data.mustChangePassword) return <Navigate to="/trocar-senha" replace />;
  if (!me.data.mfaEnabled) return <Navigate to="/mfa/cadastro" replace />;
  return <Outlet />;
}

/** Esconde a página de quem não tem a permissão (a API recusaria os dados de qualquer forma). */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const me = useMe();
  if (!me.data) return null;
  if (!me.data.permissions.includes(permission)) return <Navigate to="/sem-permissao" replace />;
  return <>{children}</>;
}
