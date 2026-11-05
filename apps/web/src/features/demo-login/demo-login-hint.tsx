import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DEMO_ACCESS } from '@/mocks/demo-access';
import type { DemoSignIn } from './entry';

/*
 * O acesso de demonstração nas telas de login (só no build do modo `mock`; veja `entry.tsx`). Quem visita vê as
 * credenciais e pode preenchê-las com um clique; quem envia é a própria pessoa ("Entrar", "Verificar"), como num login
 * de verdade. As credenciais só valem no mock do navegador.
 */

const hintClass = 'space-y-2 rounded-md border bg-medium/10 p-3 text-xs';

/** Avisa o leitor de tela do preenchimento (o foco já foi para o botão de envio). */
function Filled({ message }: { message: string | null }) {
  return (
    <p role="status" className="sr-only">
      {message}
    </p>
  );
}

export function SignInHint({ onFill }: { onFill: (access: DemoSignIn) => void }) {
  const [filled, setFilled] = useState(false);
  return (
    <div role="note" className={hintClass}>
      <p className="font-medium">Acesso de demonstração</p>
      <p>
        E-mail <span className="font-mono">{DEMO_ACCESS.email}</span>, senha{' '}
        <span className="font-mono">{DEMO_ACCESS.password}</span> e, no código,{' '}
        <span className="font-mono">{DEMO_ACCESS.totp}</span>.
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={() => {
          onFill({ email: DEMO_ACCESS.email, password: DEMO_ACCESS.password });
          setFilled(true);
        }}
      >
        Preencher acesso de demonstração
      </Button>
      <Filled message={filled ? 'E-mail e senha de demonstração preenchidos. Agora, é só entrar.' : null} />
      <p>
        Para ver o primeiro acesso (troca da senha e cadastro do MFA), entre com a senha temporária{' '}
        <span className="font-mono">{DEMO_ACCESS.temporaryPassword}</span>.
      </p>
    </div>
  );
}

export function CodeHint({ onFill }: { onFill: (code: string) => void }) {
  const [filled, setFilled] = useState(false);
  return (
    <div role="note" className={hintClass}>
      <p className="font-medium">Acesso de demonstração</p>
      <p>
        Na demonstração, o código do aplicativo é <span className="font-mono">{DEMO_ACCESS.totp}</span>.
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={() => {
          onFill(DEMO_ACCESS.totp);
          setFilled(true);
        }}
      >
        Preencher código de demonstração
      </Button>
      <Filled message={filled ? 'Código de demonstração preenchido. Agora, é só verificar.' : null} />
    </div>
  );
}
