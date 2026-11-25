import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

/** Uma lista de um item: confirmar a remoção tira o item, e o botão que abriu a janela sai com ele. */
function Example({
  onConfirm,
  removes = true,
  error = null,
  busy = false,
}: {
  onConfirm?: () => void;
  removes?: boolean;
  error?: string | null;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  return (
    <div ref={list} tabIndex={-1} data-testid="lista">
      {present && (
        <button type="button" onClick={() => setOpen(true)}>
          Remover
        </button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remover o item"
        description="O item sai da lista."
        confirmLabel="Remover item"
        busyLabel="Removendo…"
        danger
        busy={busy}
        error={error}
        onConfirm={() => {
          onConfirm?.();
          setOpen(false);
          if (removes) setPresent(false);
        }}
        fallbackFocus={list}
      />
    </div>
  );
}

describe('janela de confirmação', () => {
  it('abre com nome e descrição, prende o foco, e Esc devolve o foco para quem abriu sem confirmar', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Example onConfirm={onConfirm} />);
    const opener = screen.getByRole('button', { name: 'Remover' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Remover o item' });
    expect(dialog).toHaveAccessibleDescription('O item sai da lista.');
    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirmado, com o botão ainda na tela, o foco volta para ele; com ele fora, vai para o lugar combinado', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Example removes={false} />);
    await user.click(screen.getByRole('button', { name: 'Remover' }));
    await user.click(screen.getByRole('button', { name: 'Remover item' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remover' })).toHaveFocus());
    unmount();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Remover' }));
    await user.click(screen.getByRole('button', { name: 'Remover item' }));
    await waitFor(() => expect(screen.getByTestId('lista')).toHaveFocus());
  });

  it('enquanto o pedido anda, não fecha nem confirma de novo; a recusa é anunciada', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Remover' }));
    rerender(<Example busy />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Removendo…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(<Example error="Não foi possível remover." />);
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(
      'Não foi possível remover.',
    );
    expect(within(dialog).getByRole('button', { name: 'Remover item' })).toBeEnabled();
  });

  it('não injeta estilo na página (a CSP recusaria)', async () => {
    const user = userEvent.setup();
    const before = document.querySelectorAll('style').length;
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Remover' }));
    expect(document.querySelectorAll('style').length).toBe(before);
  });
});
