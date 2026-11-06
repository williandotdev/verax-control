import { DemoTourButton } from '@/features/tour/entry';

/**
 * Faixa do ambiente de demonstração (build no modo `mock`, usado em apresentações comerciais): deixa claro, em
 * toda tela, que os dados são fictícios, e no painel traz o botão "Fazer o tour". Nos outros modos não renderiza nada.
 */
export function DemoBanner({ mode = import.meta.env.MODE }: { mode?: string }) {
  if (mode !== 'mock') return null;
  return (
    <div role="note" className="border-b bg-medium/15 px-4 py-1 text-center text-xs text-foreground">
      Ambiente de demonstração: todos os dados são fictícios.
      <DemoTourButton />
    </div>
  );
}
