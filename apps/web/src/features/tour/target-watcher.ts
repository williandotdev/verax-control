import { type Box, EDGE, GAP, type Size } from './placement';

/**
 * - `waiting`: a tela do passo ainda está abrindo ou carregando; o cartão espera.
 * - `found`: o alvo está na tela e é destacado.
 * - `missing`: não há alvo (ou ele não apareceu no prazo, ou sumiu): o cartão fica no centro, sem destaque.
 */
export type TargetStatus = 'waiting' | 'found' | 'missing';

export interface TargetSnapshot {
  /** O passo (e a tela) a que esta foto se refere. */
  key: string | null;
  status: TargetStatus;
  /** O alvo, na janela. Enquanto o alvo novo não aparece na mesma tela, fica o do passo anterior. */
  target: Box | null;
  /** O tamanho do cartão aberto, para posicioná-lo. */
  card: Size | null;
  viewport: Size;
}

export interface WatchOptions {
  key: string;
  selectors: readonly string[];
  /** A tela do passo já está aberta. Antes disso, nada é procurado (a tela anterior pode ter um alvo igual). */
  ready: boolean;
  /** Quanto esperar o alvo antes de mostrar o cartão no centro. */
  timeoutMs: number;
}

export interface TargetWatcher {
  watch: (options: WatchOptions) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TargetSnapshot;
  /** Ref do cartão: medido a cada quadro, como o alvo. */
  setCard: (card: HTMLElement | null) => void;
}

/** Altura do cartão antes da primeira medida, para abrir espaço ao rolar até o alvo. */
const ESTIMATED_CARD_HEIGHT = 240;

function readViewport(): Size {
  const root = document.documentElement;
  return { width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
}

function toBox(rect: DOMRect): Box {
  return {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
}

function query(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/**
 * O primeiro alvo visível, na ordem dos seletores. Um alvo que existe mas está escondido (o menu recolhido no
 * celular) passa a vez ao seguinte na hora; um que ainda não existe é esperado, até o prazo acabar.
 */
function findTarget(selectors: readonly string[], timedOut: boolean): Element | null {
  for (const selector of selectors) {
    const matches = query(selector);
    const visible = matches.find(isVisible);
    if (visible) return visible;
    if (matches.length === 0 && !timedOut) return null;
  }
  return null;
}

/** Dentro de um quadro que rola por conta própria (o painel lateral), e não só na página. */
function scrollsInside(element: Element): boolean {
  for (
    let parent = element.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
      return true;
    }
  }
  return false;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Rola até o alvo quando ele está fora da janela ou sem espaço para o cartão ao lado: o alvo e o cartão ficam
 * juntos no meio da janela. Sem animação para quem pediu menos movimento.
 */
function reveal(element: Element, cardHeight: number): void {
  const viewport = readViewport();
  const rect = element.getBoundingClientRect();
  const inView = rect.top >= EDGE && rect.bottom <= viewport.height - EDGE;
  const room =
    viewport.height - EDGE - rect.bottom >= cardHeight + GAP || rect.top - EDGE >= cardHeight + GAP;
  if (inView && room) return;
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
  if (scrollsInside(element)) {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior });
    return;
  }
  const desiredTop = Math.max(EDGE, (viewport.height - (rect.height + GAP + cardHeight)) / 2);
  const delta = rect.top - desiredTop;
  if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior });
}

const sameBox = (a: Box | Size | null, b: Box | Size | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.width === b.width &&
    a.height === b.height &&
    ('top' in a ? a.top : 0) === ('top' in b ? b.top : 0) &&
    ('left' in a ? a.left : 0) === ('left' in b ? b.left : 0));

const sameSnapshot = (a: TargetSnapshot, b: TargetSnapshot): boolean =>
  a.key === b.key &&
  a.status === b.status &&
  sameBox(a.target, b.target) &&
  sameBox(a.card, b.card) &&
  sameBox(a.viewport, b.viewport);

/**
 * Acompanha o alvo do passo a cada quadro (enquanto o tour está aberto): acha o elemento quando a tela termina de
 * carregar, rola até ele uma vez e segue a posição dele (rolagem, mudança de layout, tamanho da janela). É uma fonte
 * externa para o `useSyncExternalStore`: a foto só muda quando algo mudou de fato.
 */
export function createTargetWatcher(): TargetWatcher {
  let snapshot: TargetSnapshot = {
    key: null,
    status: 'waiting',
    target: null,
    card: null,
    viewport: readViewport(),
  };
  let options: WatchOptions | null = null;
  let element: Element | null = null;
  let card: HTMLElement | null = null;
  let startedAt = 0;
  let revealed = false;
  let cardHeight = ESTIMATED_CARD_HEIGHT;
  let frame = 0;
  const listeners = new Set<() => void>();

  const emit = (next: TargetSnapshot) => {
    if (sameSnapshot(next, snapshot)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const measureCard = (): Size | null => {
    if (!card?.isConnected) return null;
    const { width, height } = toBox(card.getBoundingClientRect());
    if (height > 0) cardHeight = height;
    return { width, height };
  };

  const update = () => {
    const viewport = readViewport();
    const cardSize = measureCard();
    if (!options) {
      emit({ ...snapshot, card: cardSize, viewport });
      return;
    }
    const timedOut = performance.now() - startedAt >= options.timeoutMs;
    if (!options.ready || options.selectors.length === 0) {
      element = null;
    } else if (!element?.isConnected || !isVisible(element)) {
      element = findTarget(options.selectors, timedOut);
      revealed = false;
    }
    if (element && !revealed) {
      revealed = true;
      reveal(element, cardHeight);
    }

    let status: TargetStatus;
    if (element) status = 'found';
    else if (options.ready && options.selectors.length === 0) status = 'missing';
    // O cartão já apareceu neste passo e o alvo sumiu: o cartão vai para o centro, mas não fecha.
    else if (snapshot.key === options.key && snapshot.status !== 'waiting') status = 'missing';
    else status = timedOut ? 'missing' : 'waiting';

    emit({
      key: options.key,
      status,
      target: element
        ? toBox(element.getBoundingClientRect())
        : status === 'waiting'
          ? snapshot.target
          : null,
      card: cardSize,
      viewport,
    });
  };

  const tick = () => {
    update();
    frame = listeners.size > 0 ? requestAnimationFrame(tick) : 0;
  };

  return {
    watch(next) {
      if (
        options &&
        options.key === next.key &&
        options.ready === next.ready &&
        options.timeoutMs === next.timeoutMs &&
        options.selectors.join('\n') === next.selectors.join('\n')
      ) {
        return;
      }
      options = next;
      element = null;
      revealed = false;
      startedAt = performance.now();
      // Na mesma tela, o destaque anterior fica até o novo alvo aparecer; noutra tela, some na hora.
      emit({
        key: next.key,
        status: next.ready && next.selectors.length === 0 ? 'missing' : 'waiting',
        target: next.ready ? snapshot.target : null,
        card: snapshot.card,
        viewport: readViewport(),
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      if (frame === 0) frame = requestAnimationFrame(tick);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && frame !== 0) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      };
    },
    getSnapshot: () => snapshot,
    setCard(next) {
      card = next;
    },
  };
}
