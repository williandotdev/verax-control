import { ExternalLink } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type KeyboardEvent, useCallback, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { CardSide } from './placement';
import type { TourStep } from './steps';

export interface TourCardProps {
  step: TourStep;
  index: number;
  total: number;
  /** Onde o cartão fica; sem posição (antes da primeira medida), ele ainda não aparece. */
  placement: { top: number; left: number; side: CardSide } | null;
  /** Recebe o elemento do cartão, para medir o tamanho. */
  cardRef: (card: HTMLElement | null) => void;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
  /** O cartão saiu da tela (troca de passo ou fim do tour): quem decide o foco é o tour. */
  onUnmountFocus: () => void;
}

/**
 * Cartão de um passo: um diálogo com título, "Passo X de N" e a explicação, que recebe o foco ao abrir. Esc ou
 * "Pular" encerram; as setas, "Voltar" e "Próximo" navegam. É o `Dialog.Content` do Radix sem o `Dialog.Overlay`
 * (a trava de rolagem do overlay injeta um `<style>`, que a CSP de produção recusa); o fundo é o do tour.
 */
export function TourCard({
  step,
  index,
  total,
  placement,
  cardRef,
  onNext,
  onBack,
  onSkip,
  onFinish,
  onUnmountFocus,
}: TourCardProps) {
  const content = useRef<HTMLDivElement | null>(null);
  const countId = useId();
  const bodyId = useId();
  const first = index === 0;
  const last = index === total - 1;
  const setContent = useCallback(
    (element: HTMLDivElement | null) => {
      content.current = element;
      cardRef(element);
    },
    [cardRef],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight' && !last) {
      event.preventDefault();
      onNext();
    } else if (event.key === 'ArrowLeft' && !first) {
      event.preventDefault();
      onBack();
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onSkip();
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          ref={setContent}
          data-tour-card=""
          data-placement={placement?.side ?? 'pendente'}
          aria-describedby={`${countId} ${bodyId}`}
          style={placement ? { top: placement.top, left: placement.left } : undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onUnmountFocus();
          }}
          // Clicar fora (no fundo escurecido) não encerra: só "Pular", "Concluir" ou Esc.
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onKeyDown={onKeyDown}
          className={cn(
            'fixed top-0 left-0 z-70 flex max-h-[calc(100dvh-2rem)] w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto rounded-lg border border-border-strong bg-surface-raised p-4 text-foreground shadow-lg transition-opacity duration-200 focus:outline-none',
            placement ? 'opacity-100' : 'opacity-0',
          )}
        >
          <div className="space-y-1">
            <p id={countId} className="text-xs font-medium text-subtle-foreground">
              Passo {index + 1} de {total}
            </p>
            <Dialog.Title className="text-base font-semibold">{step.title}</Dialog.Title>
          </div>
          <Dialog.Description id={bodyId} className="text-sm text-muted-foreground">
            {step.body}
          </Dialog.Description>
          {step.link && (
            <a
              href={step.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 self-start text-sm font-medium underline underline-offset-4"
            >
              {step.link.label}
              <ExternalLink aria-hidden className="size-4" />
              <span className="sr-only">(abre em outra aba)</span>
            </a>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {last ? (
              <span />
            ) : (
              <Button variant="ghost" size="sm" onClick={onSkip}>
                Pular
              </Button>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={onBack} disabled={first}>
                Voltar
              </Button>
              {last ? (
                <Button size="sm" onClick={onFinish}>
                  Concluir
                </Button>
              ) : (
                <Button size="sm" onClick={onNext}>
                  Próximo
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
