import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { useMe } from '@/features/session/session';
import { examplePath } from './examples';
import { type Box, placeCard, spotlightBox } from './placement';
import { readTourProgress, type TourProgress, writeTourProgress } from './progress';
import { TOUR_STEPS, type TourStep, tourStepsFor } from './steps';
import { createTargetWatcher } from './target-watcher';
import { TourCard } from './tour-card';
import { onTourRequest, registerTourHost } from './tour-store';

/** Quanto esperar o alvo de um passo (a tela carregando) antes de mostrar o cartão no centro. */
const TARGET_TIMEOUT_MS = 4_000;
const NO_TARGET: readonly string[] = [];

export interface DemoTourProps {
  steps?: readonly TourStep[];
  targetTimeoutMs?: number;
}

/**
 * Tour guiado da demonstração (só existe no build do modo `mock`; veja `entry.tsx`). Abre sozinho na primeira
 * entrada no painel, retoma depois de recarregar a página e pode ser reaberto pelo botão "Fazer o tour" da faixa.
 * Passa pelas telas que o papel da pessoa enxerga.
 */
export default function DemoTour({ steps = TOUR_STEPS, targetTimeoutMs = TARGET_TIMEOUT_MS }: DemoTourProps) {
  const { data: me } = useMe();
  const permissions = me?.permissions;
  const visible = useMemo(
    () => (permissions ? tourStepsFor(permissions, steps) : null),
    [permissions, steps],
  );
  if (!visible || visible.length === 0) return null;
  return <TourController steps={visible} timeoutMs={targetTimeoutMs} />;
}

/** Progresso inicial: o guardado; quem nunca viu o tour começa pelo primeiro passo. */
function initialProgress(steps: readonly TourStep[]): TourProgress {
  const stored = readTourProgress();
  if (!stored.open && stored.seen) return stored;
  const known = steps.some((step) => step.id === stored.step);
  return { seen: stored.seen, open: true, step: known ? stored.step : (steps[0]?.id ?? null) };
}

function TourController({ steps, timeoutMs }: { steps: readonly TourStep[]; timeoutMs: number }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const here = `${pathname}${search}`;
  const [progress, setProgress] = useState(() => initialProgress(steps));
  /** Tela resolvida de cada passo com exemplo (o incidente ou achado do cliente da sessão). */
  const [examples, setExamples] = useState<Record<string, string | undefined>>({});
  /** Passo pedido por último: um exemplo que chega depois de a pessoa seguir adiante não navega. */
  const requested = useRef<string | null>(null);
  const hereRef = useRef(here);
  useEffect(() => {
    hereRef.current = here;
  }, [here]);
  /** Onde estava o foco quando o tour abriu: volta para lá quando ele encerra. */
  const opener = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  const navigatedOnMount = useRef(false);

  const found = progress.open ? steps.findIndex((step) => step.id === progress.step) : -1;
  const index = progress.open ? Math.max(0, found) : -1;
  const step = index >= 0 ? steps[index] : undefined;

  useEffect(() => {
    writeTourProgress(progress);
  }, [progress]);

  useEffect(() => registerTourHost(), []);

  const rememberOpener = () => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };

  /** Vai para a tela do passo; com exemplo, primeiro busca qual é ele no cliente da sessão. */
  const show = (target: TourStep) => {
    requested.current = target.id;
    if (!target.example) {
      if (target.path && target.path !== hereRef.current) void navigate(target.path);
      return;
    }
    void examplePath(target).then((path) => {
      setExamples((current) => ({ ...current, [target.id]: path }));
      if (requested.current === target.id && path && path !== hereRef.current) void navigate(path);
    });
  };

  const goTo = (target: TourStep) => {
    setProgress((current) => ({ ...current, open: true, step: target.id }));
    show(target);
  };

  const close = (finished: boolean) => {
    closing.current = true;
    setProgress((current) => ({ seen: true, open: false, step: finished ? null : current.step }));
  };

  // "Fazer o tour": retoma de onde parou (ou começa de novo, se já concluiu).
  const onRequest = useEffectEvent(() => {
    if (progress.open) return;
    const resume = steps.find((candidate) => candidate.id === progress.step) ?? steps[0];
    if (!resume) return;
    rememberOpener();
    goTo(resume);
  });
  useEffect(() => onTourRequest(() => onRequest()), []);

  // Abriu sozinho (primeira entrada) ou voltou de uma recarga: vai para a tela do passo.
  const openOnMount = useEffectEvent(() => {
    if (navigatedOnMount.current || !step) return;
    navigatedOnMount.current = true;
    rememberOpener();
    show(step);
  });
  useEffect(() => {
    openOnMount();
  }, []);

  if (!step) return null;

  return (
    <TourSession
      step={step}
      path={step.example ? examples[step.id] : step.path}
      pending={Boolean(step.example) && !(step.id in examples)}
      index={index}
      total={steps.length}
      here={here}
      timeoutMs={timeoutMs}
      onNext={() => {
        const next = steps[index + 1];
        if (next) goTo(next);
      }}
      onBack={() => {
        const previous = steps[index - 1];
        if (previous) goTo(previous);
      }}
      onSkip={() => close(false)}
      onFinish={() => close(true)}
      onUnmountFocus={() => {
        if (!closing.current) return;
        closing.current = false;
        const target = opener.current;
        opener.current = null;
        if (target?.isConnected) target.focus();
      }}
    />
  );
}

interface TourSessionProps {
  step: TourStep;
  /** Tela do passo (no passo com exemplo, a resolvida). */
  path: string | undefined;
  /** O exemplo do passo ainda está sendo buscado: o destaque espera. */
  pending: boolean;
  index: number;
  total: number;
  here: string;
  timeoutMs: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
  onUnmountFocus: () => void;
}

/** O tour aberto: acompanha o alvo do passo, escurece o resto da tela e posiciona o cartão. */
function TourSession({ step, path, pending, index, total, here, timeoutMs, ...actions }: TourSessionProps) {
  const [watcher] = useState(createTargetWatcher);
  const ready = !pending && (!path || path === here);
  const key = `${step.id}@${here}`;
  const selectors = step.target ?? NO_TARGET;

  useEffect(() => {
    watcher.watch({ key, selectors, ready, timeoutMs });
  }, [watcher, key, selectors, ready, timeoutMs]);

  const snapshot = useSyncExternalStore(watcher.subscribe, watcher.getSnapshot, watcher.getSnapshot);
  const current = snapshot.key === key;
  const spotlight =
    ready && snapshot.target && snapshot.status !== 'missing'
      ? spotlightBox(snapshot.target, snapshot.viewport)
      : null;
  const showCard = current && snapshot.status !== 'waiting';
  const placement =
    showCard && snapshot.card
      ? placeCard(snapshot.status === 'found' ? spotlight : null, snapshot.card, snapshot.viewport)
      : null;

  return (
    <>
      {createPortal(<TourBackdrop spotlight={spotlight} />, document.body)}
      {showCard && (
        <TourCard
          key={step.id}
          step={step}
          index={index}
          total={total}
          placement={placement}
          cardRef={watcher.setCard}
          {...actions}
        />
      )}
    </>
  );
}

/**
 * Fundo do tour: escurece a tela, deixa o alvo em destaque (um recorte com contorno) e segura os cliques, para a
 * página não mudar por baixo do cartão. A rolagem continua livre. Posição pelo `style` do React (CSSOM), que a CSP
 * de produção aceita; as cores vêm dos tokens do tema.
 */
function TourBackdrop({ spotlight }: { spotlight: Box | null }) {
  return (
    <div
      aria-hidden
      data-tour-backdrop=""
      data-spotlight={spotlight ? 'sim' : 'nao'}
      className="pointer-events-auto fixed inset-0 z-60 overflow-hidden"
    >
      {spotlight ? (
        <div
          className="absolute rounded-lg shadow-[0_0_0_200vmax_color-mix(in_oklab,var(--color-foreground)_40%,transparent)] outline-2 outline-ring"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-foreground/40" />
      )}
    </div>
  );
}
