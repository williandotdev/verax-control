import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, type RefObject, useId, useRef } from 'react';
import { Button } from './button';

/**
 * Confirmação numa janela sobre a tela (ou sobre o painel lateral): o foco fica preso nela, Esc cancela, e o foco volta para
 * quem abriu. Se quem abriu saiu da tela (o item apagado, o botão que virou outro), ele vai para `fallbackFocus`.
 *
 * O fundo é uma `div` comum, pelo mesmo motivo do `Sheet`: o overlay do Radix injeta um `<style>` que a CSP recusa.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  busyLabel,
  danger = false,
  busy,
  error,
  onConfirm,
  fallbackFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** O que a pessoa precisa ver antes de confirmar. */
  children?: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  busy: boolean;
  /** A recusa da API, já em texto; null sem recusa. */
  error: string | null;
  onConfirm: () => void;
  fallbackFocus?: RefObject<HTMLElement | null>;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const bodyId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <Dialog.Portal>
        <div aria-hidden className="pointer-events-auto fixed inset-0 z-50 bg-foreground/30" />
        <Dialog.Content
          data-sheet=""
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = opener.current;
            opener.current = null;
            if (target?.isConnected && !target.hasAttribute('disabled')) target.focus();
            else fallbackFocus?.current?.focus();
          }}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-surface shadow-lg focus:outline-none"
        >
          <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0 space-y-1">
              <Dialog.Title className="text-lg font-semibold wrap-anywhere">{title}</Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground wrap-anywhere">
                {description}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Fechar" disabled={busy}>
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </header>
          {(children !== undefined || error !== null) && (
            <div
              role="group"
              aria-labelledby={bodyId}
              tabIndex={0}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <span id={bodyId} className="sr-only">
                Detalhes da confirmação
              </span>
              {children}
              {error !== null && (
                <p role="alert" className="text-critical-text">
                  {error}
                </p>
              )}
            </div>
          )}
          <footer className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="sm" disabled={busy}>
                Cancelar
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              size="sm"
              variant={danger ? 'danger' : 'primary'}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? busyLabel : confirmLabel}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
