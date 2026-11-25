import { lazy, type ReactNode, Suspense } from 'react';
import type { WorldTraffic } from './world-map-model';
import { WorldMapSkeleton } from './world-map-skeleton';

/** O arquivo do mapa não veio (rede, ou uma versão nova publicada com a página aberta): o resto da página continua. */
function MapUnavailable() {
  return (
    <p role="alert" className="text-sm text-muted-foreground">
      Não foi possível carregar o mapa de origens. Recarregue a página para tentar de novo.
    </p>
  );
}

const WorldMap = lazy(() =>
  import('./world-map').then(
    (module) => ({ default: module.WorldMap }),
    () => ({ default: MapUnavailable }),
  ),
);

/**
 * O mapa de origens para as páginas: o desenho do mundo só é baixado quando o mapa aparece (fica fora do pacote principal),
 * com o esqueleto (ou o `fallback` de quem sabe a altura) no lugar enquanto isso.
 */
export function LazyWorldMap({
  fallback = <WorldMapSkeleton />,
  ...props
}: {
  traffic: WorldTraffic;
  userId: string;
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <WorldMap {...props} />
    </Suspense>
  );
}
