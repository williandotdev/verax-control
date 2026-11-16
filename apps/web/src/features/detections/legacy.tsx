import { Navigate, useLocation } from 'react-router';
import { legacyDetectionsUrl } from './legacy-url';

/** Rota de um endereço de antes: troca pela visão equivalente, sem deixar o endereço antigo no histórico. */
export function LegacyRedirect() {
  const location = useLocation();
  return <Navigate to={legacyDetectionsUrl(location.pathname, location.search)} replace />;
}
