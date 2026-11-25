import { LoaderCircle } from 'lucide-react';

const BLOCK = 'animate-pulse rounded-md bg-foreground/5';

/**
 * O mapa de origens enquanto carrega, no lugar e quase no tamanho dele com a lista cheia (as dez origens, as notas e a linha
 * da tabela): a página não pula quando ele chega. À parte do mapa, para a página mostrá-lo sem baixar o desenho do mundo.
 */
export function WorldMapSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy className="@container space-y-4">
      <span className="flex min-h-18 items-center gap-2 text-sm text-muted-foreground @xl:min-h-10">
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        Carregando o mapa de origens…
      </span>
      <div
        aria-hidden
        className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_17rem] @4xl:grid-rows-[auto_1fr] @4xl:gap-x-6 @7xl:grid-cols-[minmax(0,1fr)_20rem]"
      >
        <div className="min-w-0 overflow-hidden rounded-panel border bg-map-ocean">
          {/* A proporção do mapa (`WORLD_MAP_WIDTH` por `WORLD_MAP_HEIGHT`). */}
          <div className="mx-auto aspect-[100/41] w-full max-w-[73rem] animate-pulse" />
          {/* No estreito, os números do país ficam embaixo do mapa; e a legenda. */}
          <div className="h-57 border-t @md:h-29 @xl:h-17 @5xl:h-10" />
        </div>
        <div className="min-w-0 space-y-3 @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1">
          <div className="h-5 w-32 rounded-md bg-foreground/5" />
          <div className="gap-6 @xl:columns-2 @4xl:columns-1">
            {Array.from({ length: 10 }, (_, index) => (
              <div key={index} className="h-9 break-inside-avoid py-1">
                <div className={`${BLOCK} h-7`} />
              </div>
            ))}
          </div>
          <div className={`${BLOCK} h-16 @xl:h-10 @4xl:h-20`} />
        </div>
        <div className={`${BLOCK} h-44 @md:h-36 @xl:h-24 @4xl:col-start-1 @5xl:h-18`} />
      </div>
      <div aria-hidden className="h-6" />
    </div>
  );
}
