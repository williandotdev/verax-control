import type { MitreTactic } from '@verax/shared';
import { Link } from 'react-router';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { TACTIC_LABELS } from './labels';

/**
 * Intensidade pela quantidade de achados, num tom só e sutil: o número está sempre escrito, e o fundo nunca tira o
 * contraste do texto (>= 4,5:1 até sobre o fundo da página). Sem achado, a célula fica neutra. O tom é a tinta, e não
 * o azul da ação principal: ao lado dos selos de severidade (na Torre), um fundo azul passaria por "baixo".
 */
function intensity(findings: number, max: number): string {
  if (findings === 0 || max === 0) return 'bg-surface';
  const ratio = findings / max;
  if (ratio > 0.66) return 'bg-foreground/16 border-foreground/40';
  if (ratio > 0.33) return 'bg-foreground/10 border-foreground/30';
  return 'bg-foreground/5 border-foreground/20';
}

/** As 14 táticas do MITRE ATT&CK na ordem da cadeia de ataque, com achados, incidentes e a técnica mais vista. */
export function MitreGrid({ tactics, to }: { tactics: readonly MitreTactic[]; to?: string }) {
  const max = Math.max(0, ...tactics.map((tactic) => tactic.findings));
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {tactics.map((tactic) => {
        const label = TACTIC_LABELS[tactic.name] ?? tactic.name;
        const top = tactic.techniques[0];
        const description = `${label} (${tactic.id}): ${plural(tactic.findings, 'achado', 'achados')}, ${plural(tactic.incidents, 'incidente', 'incidentes')}`;
        const body = (
          <>
            <span className="block text-xs text-muted-foreground">{tactic.id}</span>
            <span className="block text-sm font-medium leading-tight">{label}</span>
            <span className="mt-1 block text-2xl font-semibold tabular-nums">{tactic.findings}</span>
            <span className="block text-xs text-muted-foreground">
              {plural(tactic.incidents, 'incidente', 'incidentes')}
              {top && <> · {top.id}</>}
            </span>
          </>
        );
        const className = cn(
          'block h-full rounded-md border p-2',
          intensity(tactic.findings, max),
          to && 'hover:border-foreground/40',
        );
        return (
          <li key={tactic.id}>
            {to ? (
              <Link to={to} aria-label={description} className={className}>
                {body}
              </Link>
            ) : (
              <div aria-label={description} className={className}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
