import { useSyncExternalStore } from 'react';
import { hasTourHost, requestTour, subscribeTourHosts } from './tour-store';

/** Botão "Fazer o tour" da faixa da demonstração. Só aparece dentro do painel, onde o tour existe. */
export default function TourLauncher() {
  const available = useSyncExternalStore(subscribeTourHosts, hasTourHost, hasTourHost);
  if (!available) return null;
  return (
    <>
      {' '}
      <button
        type="button"
        onClick={requestTour}
        className="ml-1 inline-flex h-6 items-center rounded-sm px-2 font-medium underline underline-offset-2 hover:bg-foreground/10"
      >
        Fazer o tour
      </button>
    </>
  );
}
