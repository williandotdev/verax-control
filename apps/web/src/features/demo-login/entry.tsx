import { lazy, Suspense } from 'react';

/*
 * Pontos de montagem do acesso de demonstração nas telas de login. Só existe no build do modo `mock`: em qualquer outro
 * modo as constantes abaixo viram `null`, o Vite remove os imports dinâmicos e nem o texto dos botões nem as
 * credenciais de exemplo chegam ao bundle de produção (como o tour, em `features/tour/entry.tsx`).
 */
const SignInHint =
  import.meta.env.MODE === 'mock'
    ? lazy(() => import('./demo-login-hint').then((module) => ({ default: module.SignInHint })))
    : null;
const CodeHint =
  import.meta.env.MODE === 'mock'
    ? lazy(() => import('./demo-login-hint').then((module) => ({ default: module.CodeHint })))
    : null;

/** O que o botão do login preenche. */
export interface DemoSignIn {
  email: string;
  password: string;
}

/** No login: o acesso de exemplo e o botão "Preencher acesso de demonstração" (preenche, não envia). */
export function DemoLoginHint({ onFill }: { onFill: (access: DemoSignIn) => void }) {
  if (!SignInHint) return null;
  return (
    <Suspense fallback={null}>
      <SignInHint onFill={onFill} />
    </Suspense>
  );
}

/** No código do MFA: o código de exemplo e o botão "Preencher código de demonstração". */
export function DemoCodeHint({ onFill }: { onFill: (code: string) => void }) {
  if (!CodeHint) return null;
  return (
    <Suspense fallback={null}>
      <CodeHint onFill={onFill} />
    </Suspense>
  );
}
