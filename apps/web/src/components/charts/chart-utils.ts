import { type RefObject, useLayoutEffect, useRef, useState } from 'react';

/**
 * Peças comuns dos gráficos do painel (SVG puro, sem biblioteca): formatos em pt-BR, escala do eixo, largura medida
 * e a rampa de tinta para categorias sem severidade.
 */

const integer = new Intl.NumberFormat('pt-BR');
const percentWhole = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
const percentFine = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 });
const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});
const asDate = (date: string): Date => new Date(`${date}T00:00:00Z`);

/** "1.234". */
export const formatCount = (value: number): string => integer.format(value);

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

/** Valor de cartão, compacto acima de 10 mil: "9.876", "12,3 mil", "1,2 mi". */
export const formatCompact = (value: number): string =>
  Math.abs(value) < 10_000 ? integer.format(value) : compact.format(value);

const hourMinute = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** A hora de um instante no fuso do navegador: "14:00". */
export const formatHour = (value: string | Date): string =>
  hourMinute.format(typeof value === 'string' ? new Date(value) : value);

/** "45%"; abaixo de 10%, com uma casa ("4,5%"), para uma fatia pequena não virar "0%". */
export const formatShare = (ratio: number): string =>
  (ratio < 0.1 ? percentFine : percentWhole).format(ratio);

/** Data de calendário (AAAA-MM-DD, UTC) curta, para o eixo: "05/10". */
export const formatShortDate = (date: string): string => dayMonth.format(asDate(date));

/** Data de calendário (AAAA-MM-DD, UTC) inteira: "05/10/2026". */
export const formatDate = (date: string): string => fullDate.format(asDate(date));

/** "1 achado", "1.234 achados". */
export const countOf = (value: number, unit: ChartUnit): string =>
  `${formatCount(value)} ${value === 1 ? unit.one : unit.many}`;

export interface ChartUnit {
  one: string;
  many: string;
}

/**
 * Marcas do eixo de contagem: números redondos (passo de 1, 2 ou 5 vezes uma potência de 10, nunca fracionário), do
 * zero até o primeiro múltiplo do passo que cobre o máximo, em umas quatro divisões.
 */
export function countTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(
    1,
    [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= raw) ?? 1,
  );
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: top / step + 1 }, (_, index) => index * step);
}

/** Largura aproximada de um texto curto em px (as fontes mais largas do Linux do CI entram na conta). */
export const textWidth = (text: string, fontSize = 11): number => text.length * fontSize * 0.62;

/**
 * Largura do elemento em px, acompanhando o redimensionamento. Devolve o `ref` (de função: vale também para o quadro
 * que só aparece depois, quando o período deixa de estar vazio), a largura e o próprio elemento. Antes da primeira
 * medida (e no jsdom, que não tem `ResizeObserver`), vale a largura de reserva: o SVG escala até a medida chegar.
 */
export function useElementWidth<T extends HTMLElement>(
  fallback: number,
): [(element: T | null) => void, number, T | null] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width ?? fallback, element];
}

/**
 * Mantém a dica (tooltip) dentro do quadro do gráfico: desloca na horizontal o que passaria da borda. Mexe só na
 * margem do próprio elemento (CSSOM, aceito pela CSP; o `translate` fica com as classes de posição), depois do layout
 * e antes da pintura. Devolve o `ref` da dica; `key` muda quando a dica muda de lugar.
 */
export function useKeepInside<T extends HTMLElement>(
  frame: HTMLElement | null,
  key: unknown,
): RefObject<T | null> {
  const tip = useRef<T>(null);
  useLayoutEffect(() => {
    const element = tip.current;
    if (!frame || !element) return;
    element.style.marginLeft = '';
    const outer = frame.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    const shift =
      inner.left < outer.left
        ? outer.left - inner.left
        : inner.right > outer.right
          ? outer.right - inner.right
          : 0;
    if (shift !== 0) element.style.marginLeft = `${shift}px`;
  }, [frame, key]);
  return tip;
}

/**
 * Rampa ordinal na tinta do tema, para categorias que têm ordem e não são severidade (o status do achado, do novo ao
 * resolvido). É a mesma escolha do mapa do MITRE: azul passaria por "baixo" ao lado dos selos de severidade.
 * Mais tinta, mais atenção pendente. Validada com o script da skill de visualização (`--ordinal`) sobre a superfície
 * dos cartões, nos dois temas: um tom só, claridade monotônica, passo de claridade >= 0,06 e a ponta mais clara
 * >= 2:1 contra a superfície (claro: #13233c, #5a6577, #89919e, #acb2bb sobre #ffffff, a ponta a 2,13:1; escuro:
 * #f5f7fb, #b0b6c1, #838b9b, #606b7e sobre #101f3b, a ponta a 3,05:1).
 * `ink` é a cor do número escrito dentro da fatia, >= 4,5:1 sobre o tom nos dois temas (no terceiro passo, a tinta
 * certa muda com o tema). Para valer, o gráfico fica sobre `bg-surface`.
 */
export const INK_RAMP = [
  { fill: 'fill-foreground', swatch: 'bg-foreground', ink: 'fill-surface' },
  { fill: 'fill-foreground/70', swatch: 'bg-foreground/70', ink: 'fill-surface' },
  { fill: 'fill-foreground/50', swatch: 'bg-foreground/50', ink: 'fill-foreground dark:fill-surface' },
  { fill: 'fill-foreground/35', swatch: 'bg-foreground/35', ink: 'fill-foreground' },
] as const;
