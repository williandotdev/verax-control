import { type RefObject, useEffect, useRef } from 'react';

/**
 * Devolve o foco ao botão que abriu um formulário (`data-abre`), depois que a tela voltou a ter o botão; se ele saiu ou não
 * pode ser usado, à lista. Num efeito, e não no quadro seguinte: numa máquina lenta, o quadro chega antes do redesenho.
 */
export function useReturnFocus(editing: string | null): RefObject<HTMLDivElement | null> {
  const list = useRef<HTMLDivElement>(null);
  const opener = useRef<string | null>(null);
  useEffect(() => {
    if (editing !== null) {
      opener.current = editing;
      return;
    }
    const closed = opener.current;
    if (closed === null) return;
    opener.current = null;
    const button = [...(list.current?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.dataset['abre'] === closed,
    );
    if (button !== undefined && !button.disabled) button.focus();
    else list.current?.focus();
  }, [editing]);
  return list;
}
