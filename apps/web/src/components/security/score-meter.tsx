import { DEFAULT_THRESHOLDS, type ScoreThresholds, scoreSeverity } from '@/design/score';
import { SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';

const FILL: Record<'critical' | 'medium' | 'ok', { fill: string; track: string; label: string }> = {
  critical: { fill: 'fill-critical', track: 'fill-critical/20', label: 'Crítica' },
  medium: { fill: 'fill-medium', track: 'fill-medium/25', label: 'Em atenção' },
  ok: { fill: 'fill-ok', track: 'fill-ok/20', label: 'Boa' },
};

const WIDTH = 240;
const HEIGHT = 12;

/**
 * Medidor de nota de 0 a 100 (postura). Barra horizontal, como pede o guia de visualização para "um valor
 * contra um limite": o preenchimento carrega a severidade e o trilho é um tom mais claro da mesma cor, para o
 * estado ser lido na barra inteira. O número e o rótulo com ícone dão o valor sem depender da cor.
 */
export function ScoreMeter({
  score,
  label = 'Nota de postura',
  thresholds = DEFAULT_THRESHOLDS,
  className,
}: {
  score: number;
  label?: string;
  thresholds?: ScoreThresholds;
  className?: string;
}) {
  const value = Math.round(Math.min(100, Math.max(0, score)));
  const severity = scoreSeverity(value, thresholds) as 'critical' | 'medium' | 'ok';
  const { fill, track, label: stateLabel } = FILL[severity];
  const { icon: Icon, tone } = SEVERITY_STYLES[severity];
  const filled = (WIDTH * value) / 100;

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Icon aria-hidden className={cn('size-3.5', tone)} />
          {stateLabel}
        </span>
      </div>
      <p className="text-4xl font-semibold leading-none">
        {value}
        <span className="ml-1 text-base font-normal text-muted-foreground">/ 100</span>
      </p>
      <svg
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${value} de 100, ${stateLabel.toLowerCase()}`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-3 w-full"
      >
        <rect width={WIDTH} height={HEIGHT} rx={HEIGHT / 2} className={track} />
        {value > 0 && (
          <rect width={Math.max(filled, HEIGHT)} height={HEIGHT} rx={HEIGHT / 2} className={fill} />
        )}
      </svg>
    </div>
  );
}
