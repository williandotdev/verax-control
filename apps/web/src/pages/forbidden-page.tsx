import { Link } from 'react-router';

export function ForbiddenPage() {
  return (
    <main className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Sem permissão</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Seu perfil não tem acesso a esta área. Se precisar, fale com o administrador do seu cliente.
      </p>
      <Link className="mt-4 inline-block text-sm underline" to="/">
        Voltar ao início
      </Link>
    </main>
  );
}
