import { FRANCHISE_SOURCES, type FranchiseUsage, GB_BYTES, type MeteredSource } from '@verax/shared';
import { useId } from 'react';
import { ChartTable } from '@/components/charts/chart-table';
import { INK_RAMP } from '@/components/charts/chart-utils';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import {
  formatCycle,
  formatGb,
  formatGbPerDay,
  formatOverage,
  formatPercent,
  formatShortDay,
} from './plan-format';

/** O nome de cada fonte no gráfico e na tabela. */
const SOURCE_LABELS: Readonly<Record<MeteredSource, string>> = {
  aws: 'AWS',
  gcp: 'GCP',
  cloudflare: 'Cloudflare (auditoria)',
};

/** Uma tinta da rampa neutra validada dos gráficos por fonte (nunca uma cor de severidade). */
const SOURCE_INK: Readonly<Record<MeteredSource, string>> = {
  aws: INK_RAMP[0].swatch,
  gcp: INK_RAMP[1].swatch,
  cloudflare: INK_RAMP[2].swatch,
};

/**
 * O contador da franquia da Plataforma (CE-10), em "Plano e uso": o volume do ciclo contra o orçamento do ciclo
 * (`B = Σ F_d`), com a marca do ponto do ciclo em que estamos (dia `k` de `D`), a média, a projeção e o excedente
 * projetado em GB/dia (sem valor em dinheiro: o preço chega depois, pelo estado desejado). "Ampliar franquia" fica
 * desligado até o fluxo de ampliação (CE-19).
 */
export function FranchiseCard({ franchise }: { franchise: FranchiseUsage }) {
  const titleId = useId();
  const meterId = useId();
  const noteId = useId();
  const { cycle, budgetGb, usedBytes } = franchise;
  const budgetBytes = budgetGb * GB_BYTES;
  const ratio = budgetBytes === 0 ? 0 : usedBytes / budgetBytes;
  const elapsed = cycle.day / cycle.days;
  const over = franchise.projectedOverageUnits > 0;
  const changes = franchise.schedule.slice(1);
  return (
    <Card aria-labelledby={titleId} className="space-y-4">
      <div className="space-y-1">
        <CardTitle id={titleId}>Franquia de {franchise.franchiseGbPerDay} GB/dia</CardTitle>
        <CardDescription className="max-w-3xl">
          Ciclo de {formatCycle(cycle.start, cycle.end)}, no calendário de Brasília: hoje é o dia {cycle.day}{' '}
          de {cycle.days}. O volume é o dos logs lidos (AWS, GCP e a auditoria do Cloudflare), em GB de 10⁹
          bytes.
        </CardDescription>
        {changes.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Mudanças neste ciclo:{' '}
            {changes
              .map((change) => `a partir de ${formatShortDay(change.from)}, ${change.gbPerDay} GB/dia`)
              .join('; ')}
            .
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p id={meterId} className="text-sm font-medium text-muted-foreground">
          Volume do ciclo
        </p>
        <p className="text-2xl font-semibold">
          {formatGb(usedBytes)} de {formatGb(budgetBytes)}
        </p>
        <CycleMeter
          ratio={ratio}
          elapsed={elapsed}
          over={ratio > elapsed}
          labelledBy={meterId}
          valueText={`${formatGb(usedBytes)} de ${formatGb(budgetBytes)} do ciclo (${formatPercent(ratio)}); hoje é o dia ${cycle.day} de ${cycle.days} (${formatPercent(elapsed)} do ciclo)`}
        />
        <p className="text-xs text-muted-foreground">
          A marca vertical é o ponto do ciclo em que estamos ({formatPercent(elapsed)}): com a barra antes
          dela, o volume está dentro do ritmo da franquia.
        </p>
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat label="Média do ciclo" value={formatGbPerDay(franchise.dailyAverageBytes)} />
        <Stat label="Projeção do ciclo" value={formatGb(franchise.projectedBytes)} />
        <Stat
          label="Excedente projetado"
          value={over ? formatOverage(franchise.projectedOverageUnits) : 'Nenhum'}
        />
      </dl>
      <p className="max-w-3xl text-sm text-muted-foreground">
        {over
          ? 'No ritmo de agora, o ciclo passa da franquia. A coleta continua: nenhum log é descartado, e o excedente (a média diária do ciclo acima da franquia) entra na fatura seguinte.'
          : 'No ritmo de agora, o ciclo fica dentro da franquia. Acima dela, a coleta continua: nenhum log é descartado, e o excedente entra na fatura seguinte.'}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled aria-describedby={noteId}>
          Ampliar franquia
        </Button>
        <p id={noteId} className="text-sm text-muted-foreground">
          Em breve: ampliar a franquia pelo painel. Por enquanto, fale com a Verax.
        </p>
      </div>
    </Card>
  );
}

/** A barra do ciclo: o preenchimento é o volume contra o orçamento; a marca, o ponto do ciclo em que estamos. */
function CycleMeter({
  ratio,
  elapsed,
  over,
  labelledBy,
  valueText,
}: {
  ratio: number;
  elapsed: number;
  over: boolean;
  labelledBy: string;
  valueText: string;
}) {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  return (
    <div className="relative pt-1 pb-1">
      <div
        role="meter"
        aria-labelledby={labelledBy}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={valueText}
        className="h-2.5 w-full overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={cn('h-full rounded-full', over ? 'bg-medium' : 'bg-ok')}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span
        aria-hidden
        data-testid="marca-do-ciclo"
        className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 rounded bg-foreground"
        style={{ left: `${Math.min(100, Math.max(0, elapsed * 100))}%` }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
    </div>
  );
}

const CHART_HEIGHT = 96;

/**
 * O volume por dia dos últimos 30 dias, por fonte: colunas empilhadas na rampa neutra, com a linha da franquia de
 * hoje. Os números estão em "Ver tabela".
 */
export function FranchiseDaysCard({ franchise }: { franchise: FranchiseUsage }) {
  const titleId = useId();
  const { days } = franchise;
  const totals = days.map((day) => day.aws + day.gcp + day.cloudflare);
  const franchiseBytes = franchise.franchiseGbPerDay * GB_BYTES;
  const max = Math.max(franchiseBytes, ...totals, 1);
  const busiest = totals.indexOf(Math.max(...totals));
  const total = totals.reduce((sum, value) => sum + value, 0);
  const summary =
    total === 0
      ? 'Nenhum volume nos últimos 30 dias.'
      : `Volume por dia nos últimos 30 dias: ${formatGb(total)} no total; o dia com mais foi ${formatShortDay(days[busiest]?.day ?? '')}, com ${formatGb(totals[busiest] ?? 0)}. A franquia de hoje é ${franchise.franchiseGbPerDay} GB/dia.`;
  const line = (franchiseBytes / max) * 100;
  return (
    <Card aria-labelledby={titleId}>
      <CardTitle id={titleId}>Volume por dia</CardTitle>
      <CardDescription className="mt-1">
        Últimos 30 dias, por fonte, contra a franquia de hoje.
      </CardDescription>
      <figure className="mt-3">
        <div role="img" aria-label={summary} className="relative" style={{ height: CHART_HEIGHT }}>
          <div className="flex h-full items-end gap-px" aria-hidden>
            {days.map((day) => (
              <div key={day.day} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-px">
                {[...FRANCHISE_SOURCES]
                  .reverse()
                  .map((source) =>
                    day[source] === 0 ? null : (
                      <div
                        key={source}
                        className={cn('w-full rounded-[1px]', SOURCE_INK[source])}
                        style={{ height: `${(day[source] / max) * 100}%` }}
                      />
                    ),
                  )}
              </div>
            ))}
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute right-0 left-0 border-t-2 border-dashed border-medium"
            style={{ bottom: `${line}%` }}
          />
        </div>
        <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {FRANCHISE_SOURCES.map((source) => (
            <span key={source} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn('size-2.5 rounded-sm', SOURCE_INK[source])} />
              {SOURCE_LABELS[source]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="w-3 border-t-2 border-dashed border-medium" />
            Franquia de hoje ({franchise.franchiseGbPerDay} GB/dia)
          </span>
          <span className="ml-auto">
            {formatShortDay(days[0]?.day ?? '')} a {formatShortDay(days.at(-1)?.day ?? '')}
          </span>
        </figcaption>
      </figure>
      <ChartTable
        title="Volume por dia e por fonte, últimos 30 dias"
        headers={['Dia', ...FRANCHISE_SOURCES.map((source) => SOURCE_LABELS[source]), 'Total']}
        rows={days.map((day, index) => ({
          key: day.day,
          cells: [
            formatShortDay(day.day),
            ...FRANCHISE_SOURCES.map((source) => formatGb(day[source])),
            formatGb(totals[index] ?? 0),
          ],
        }))}
      />
    </Card>
  );
}
