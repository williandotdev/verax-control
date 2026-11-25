import { useState } from 'react';
import { LazyWorldMap } from '@/components/security/world-map-lazy';
import { WorldMapSkeleton } from '@/components/security/world-map-skeleton';
import { Card } from '@/components/ui/card';
import { CatalogSection } from './catalog-section';
import { WORLD_MAP_DEMOS } from './world-map-demo';

/** O mapa de origens no catálogo, na largura toda (como a faixa da tela Detecções), com um seletor de estado. */
export function WorldMapShowcase() {
  const [key, setKey] = useState(WORLD_MAP_DEMOS[0]?.key ?? '');
  const demo = WORLD_MAP_DEMOS.find((item) => item.key === key);
  return (
    <CatalogSection
      title="Mapa de origens"
      description="De que países vieram as requisições: um ponto por país, no tamanho do volume. O comum é um círculo na tinta neutra; o suspeito, um octógono com anel na cor do crítico; a onda, só em quem teve requisição agora, com botão de pausa. Dados fictícios."
    >
      <label className="flex w-fit max-w-full flex-col gap-1 text-xs text-muted-foreground">
        Estado do mapa
        <select
          className="h-9 max-w-full rounded-md border bg-surface-raised px-2 text-sm text-foreground"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        >
          {WORLD_MAP_DEMOS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <Card data-testid="mapa-de-origens">
        {demo?.traffic ? (
          <LazyWorldMap key={demo.key} traffic={demo.traffic} userId="catalogo" />
        ) : (
          <WorldMapSkeleton />
        )}
      </Card>
    </CatalogSection>
  );
}
