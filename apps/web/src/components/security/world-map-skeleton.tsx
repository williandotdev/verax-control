import { LoaderCircle } from 'lucide-react';

/**
 * O mapa de origens enquanto carrega, no lugar e no tamanho dele (a página não pula quando ele chega). À parte do mapa,
 * para a página mostrá-lo sem baixar o desenho do mundo.
 */
export function WorldMapSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy className="@container space-y-4">
      <span className="flex min-h-8 items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        Carregando o mapa de origens…
      </span>
      <div
        aria-hidden
        className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_17rem] @4xl:gap-6 @7xl:grid-cols-[minmax(0,1fr)_20rem]"
      >
        {/* A proporção do mapa (`WORLD_MAP_WIDTH` por `WORLD_MAP_HEIGHT`). */}
        <div className="aspect-[100/41] w-full animate-pulse rounded-panel border bg-map-ocean" />
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-7 animate-pulse rounded-md bg-foreground/5" />
          ))}
        </div>
      </div>
    </div>
  );
}
