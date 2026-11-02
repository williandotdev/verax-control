import { CircleAlert, CircleCheck, Info, type LucideIcon, OctagonAlert, TriangleAlert } from 'lucide-react';

/** Escala de severidade do painel, do mais grave ao normal. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'ok'] as const;
export type Severity = (typeof SEVERITIES)[number];

interface SeverityStyle {
  label: string;
  /** Forma própria por nível: identifica a severidade sem depender da cor (daltonismo, impressão). */
  icon: LucideIcon;
  /** Classe de cor do ícone e da marca (a tinta do texto continua neutra). */
  tone: string;
  /** Fundo e borda suaves para chips e cartões. */
  surface: string;
}

export const SEVERITY_STYLES: Readonly<Record<Severity, SeverityStyle>> = {
  critical: {
    label: 'Crítico',
    icon: OctagonAlert,
    tone: 'text-critical',
    surface: 'bg-critical/10 border-critical/50',
  },
  high: {
    label: 'Alto',
    icon: TriangleAlert,
    tone: 'text-high',
    surface: 'bg-high/10 border-high/60',
  },
  medium: {
    label: 'Médio',
    icon: CircleAlert,
    tone: 'text-medium',
    surface: 'bg-medium/15 border-medium/70',
  },
  low: {
    label: 'Baixo',
    icon: Info,
    tone: 'text-low',
    surface: 'bg-low/10 border-low/50',
  },
  ok: {
    label: 'Ok',
    icon: CircleCheck,
    tone: 'text-ok',
    surface: 'bg-ok/10 border-ok/50',
  },
};

/** Ordenação: mais grave primeiro. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b);
}
