import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  /** Volta o rascunho a um conteúdo que a tela sabe desenhar (o salvo, ou o ponto de partida). */
  onReset: () => void;
}

interface State {
  failed: boolean;
}

/**
 * Última defesa do formulário: se um rascunho com forma inesperada (um arquivo importado) ainda assim quebrar o
 * desenho, a tela mostra o aviso e o botão de voltar, em vez da página de erro do roteador. A forma é conferida antes
 * (`features/versions/shape.ts`) e as prévias ignoram o que não entendem; isto só pega o que escapar.
 */
export class FormErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-critical/40 bg-critical/5 p-4"
      >
        <p className="flex items-center gap-2 font-medium">
          <TriangleAlert aria-hidden className="size-4 text-critical" />
          Este conteúdo não tem a forma que o formulário espera e não pôde ser mostrado.
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            this.props.onReset();
            this.setState({ failed: false });
          }}
        >
          Voltar ao conteúdo anterior
        </Button>
      </div>
    );
  }
}
