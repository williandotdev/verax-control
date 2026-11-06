import { BrandLockup, VeraxSymbol, VeraxWordmark } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SEVERITIES, SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';
import { CatalogSection } from './catalog-section';
import { ComponentsShowcase } from './components-showcase';

/**
 * Catálogo interno do design system (T6.2/T6.3). Só existe no build de desenvolvimento: a rota nem é
 * registrada em produção.
 */

const BASE_TOKENS = [
  ['background', 'Fundo da página', 'bg-background'],
  ['surface', 'Superfície (cartões)', 'bg-surface'],
  ['surface-raised', 'Superfície elevada', 'bg-surface-raised'],
  ['foreground', 'Tinta principal', 'bg-foreground'],
  ['muted-foreground', 'Tinta secundária', 'bg-muted-foreground'],
  ['subtle-foreground', 'Tinta discreta (eixos)', 'bg-subtle-foreground'],
  ['border-strong', 'Borda forte', 'bg-border-strong'],
  ['gridline', 'Linha de grade', 'bg-gridline'],
  ['primary', 'Ação principal', 'bg-primary'],
  ['primary-hover', 'Ação principal (hover)', 'bg-primary-hover'],
  ['ring', 'Foco', 'bg-ring'],
  ['brand', 'Navy da marca', 'bg-brand'],
] as const;

const SEVERITY_SWATCH: Record<(typeof SEVERITIES)[number], string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  ok: 'bg-ok',
};

const TYPE_SCALE = [
  ['text-3xl font-semibold', 'Título de página', '30px'],
  ['text-xl font-semibold', 'Título de seção', '20px'],
  ['text-base font-semibold', 'Título de cartão', '16px'],
  ['text-sm', 'Texto corrente', '14px'],
  ['text-xs text-muted-foreground', 'Legenda e metadado', '12px'],
] as const;

const SPACING = [1, 2, 3, 4, 6, 8, 12] as const;

export function CatalogPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-10 p-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Catálogo do design system</h1>
          <p className="text-sm text-muted-foreground">
            Tokens e componentes do painel. Só no ambiente de desenvolvimento.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <CatalogSection
        title="Marca"
        description="A logo do site em SVG, na cor do texto em volta: a mesma nos dois temas e sobre o navy da marca."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="brand-surface flex flex-col items-start justify-center gap-5 rounded-xl p-6">
            <BrandLockup size="lg" />
            <BrandLockup />
          </div>
          <Card className="flex items-center gap-6">
            <VeraxWordmark label="Verax" className="h-8" />
            <VeraxSymbol label="Símbolo da Verax" className="h-8 text-primary" />
          </Card>
        </div>
      </CatalogSection>

      <CatalogSection
        title="Cores de severidade"
        description="Sempre com ícone e rótulo; a cor nunca carrega o significado sozinha."
      >
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {SEVERITIES.map((severity) => {
            const { label, icon: Icon, tone } = SEVERITY_STYLES[severity];
            return (
              <li key={severity} className="rounded-lg border bg-surface p-3">
                <div className={cn('h-10 rounded-md', SEVERITY_SWATCH[severity])} />
                <p className="mt-2 flex items-center gap-1.5 text-sm font-medium">
                  <Icon aria-hidden className={cn('size-4', tone)} />
                  {label}
                </p>
                <p className="font-mono text-xs text-muted-foreground">--severity-{severity}</p>
              </li>
            );
          })}
        </ul>
      </CatalogSection>

      <CatalogSection title="Cores de base">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {BASE_TOKENS.map(([token, label, swatch]) => (
            <li key={token} className="rounded-lg border bg-surface p-3">
              <div className={cn('h-10 rounded-md border', swatch)} />
              <p className="mt-2 text-sm font-medium">{label}</p>
              <p className="font-mono text-xs text-muted-foreground">--{token}</p>
            </li>
          ))}
        </ul>
      </CatalogSection>

      <CatalogSection
        title="Tipografia"
        description="A pilha do site: Inter quando instalada, senão a do sistema. Em tudo, inclusive números grandes."
      >
        <Card className="space-y-2">
          {TYPE_SCALE.map(([classes, label, size]) => (
            <p key={label} className={classes}>
              {label} <span className="font-mono text-xs font-normal text-subtle-foreground">{size}</span>
            </p>
          ))}
        </Card>
      </CatalogSection>

      <CatalogSection title="Espaçamento" description="Escala de 4 px do Tailwind.">
        <Card className="space-y-2">
          {SPACING.map((step) => (
            <div key={step} className="flex items-center gap-3">
              <span className="w-10 font-mono text-xs text-muted-foreground">{step * 4}px</span>
              <div className="h-3 rounded-sm bg-foreground/30" style={{ width: step * 4 }} />
            </div>
          ))}
        </Card>
      </CatalogSection>

      <CatalogSection title="Botões">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Variações</CardTitle>
              <CardDescription>
                Ação principal no azul dos links do site, com o texto em AA nos dois temas. Severidade nunca
                usa essa cor.
              </CardDescription>
            </div>
          </CardHeader>
          <div className="flex flex-wrap gap-2">
            <Button>Principal</Button>
            <Button variant="secondary">Secundário</Button>
            <Button variant="ghost">Discreto</Button>
            <Button variant="danger">Destrutivo</Button>
            <Button disabled>Desabilitado</Button>
          </div>
        </Card>
      </CatalogSection>

      <ComponentsShowcase />
    </main>
  );
}
