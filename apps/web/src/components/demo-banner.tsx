/**
 * Faixa do ambiente de demonstração (build no modo `mock`, usado em apresentações comerciais): deixa claro, em
 * toda tela, que os dados são fictícios. Nos outros modos não renderiza nada.
 */
export function DemoBanner({ mode = import.meta.env.MODE }: { mode?: string }) {
  if (mode !== 'mock') return null;
  return (
    <div role="note" className="border-b bg-medium/15 px-4 py-1 text-center text-xs text-foreground">
      Ambiente de demonstração: todos os dados são fictícios.
    </div>
  );
}

/**
 * Na tela de login da demonstração, o acesso de exemplo: quem sair durante uma apresentação consegue voltar. As
 * credenciais só existem no mock do navegador; fora do modo `mock`, nada aparece.
 */
export function DemoLoginHint({ mode = import.meta.env.MODE }: { mode?: string }) {
  if (mode !== 'mock') return null;
  return (
    <div role="note" className="rounded-md border bg-medium/10 p-3 text-xs">
      <p className="font-medium">Acesso de demonstração</p>
      <p>
        E-mail <span className="font-mono">analista@demo.verax.local</span>, senha{' '}
        <span className="font-mono">senha-de-demonstracao</span> e, no código,{' '}
        <span className="font-mono">123456</span>.
      </p>
      <p className="mt-1">
        Para ver o primeiro acesso (troca da senha e cadastro do MFA), entre com a senha temporária{' '}
        <span className="font-mono">senha-temporaria-demonstracao</span>.
      </p>
    </div>
  );
}
