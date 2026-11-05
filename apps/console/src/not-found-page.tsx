import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Página não encontrada</h1>
      <p className="text-sm">
        <Link to="/modelos-de-custo" className="text-primary underline-offset-2 hover:underline">
          Voltar aos modelos de custo
        </Link>
      </p>
    </div>
  );
}
