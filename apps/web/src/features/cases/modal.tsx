import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/** Para onde o foco vai quando quem abriu o diálogo não existe mais (a barra some com a seleção): a lista. */
function listRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-tour="deteccoes-lista"]');
}

/**
 * Diálogo modal no centro da tela, com rodapé. O mesmo padrão do de promover a incidente: o fundo é uma div comum, porque a
 * CSP de produção recusa o estilo que o overlay do Radix injeta. Abre por estado (sem gatilho), então ele mesmo guarda quem
 * tinha o foco e o devolve ao fechar.
 *
 * Não é um formulário: um Enter perdido numa opção não confirma nada. Só o botão do rodapé confirma.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <div aria-hidden className="pointer-events-auto fixed inset-0 z-50 bg-foreground/30" />
        <Dialog.Content
          data-sheet=""
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = opener.current?.isConnected ? opener.current : listRegion();
            target?.focus();
            opener.current = null;
          }}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-surface shadow-lg focus:outline-none',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0 space-y-1">
              <Dialog.Title className="line-clamp-3 text-lg font-semibold wrap-anywhere">
                {title}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Fechar"
                className="max-md:size-11"
              >
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
          <footer className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
