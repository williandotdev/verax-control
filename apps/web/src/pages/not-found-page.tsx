import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Página não encontrada</h1>
      <p className="mt-2 text-sm text-muted-foreground">O endereço não existe ou mudou.</p>
      <Link className="mt-4 inline-block text-sm underline" to="/">
        Voltar ao início
      </Link>
    </main>
  );
}
