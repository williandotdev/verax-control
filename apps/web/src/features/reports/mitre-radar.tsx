import type { MitreTactic } from '@verax/shared';
import { Fragment, useId, useMemo } from 'react';
import { Link } from 'react-router';
import { type SpiderAxis, SpiderChart } from '@/components/charts/spider-chart';
import { wrapLabel } from '@/components/charts/spider-geometry';
import { cn } from '@/lib/cn';
import { formatCount, formatList, plural } from '@/lib/format';
import { TACTIC_SHORT_LINES } from './labels';
import {
  formatPart,
  rankedTactics,
  type ShareBasis,
  shareBasis,
  spokenPart,
  type TacticShare,
  tacticShares,
} from './tactic-share';

/** Quantas técnicas a dica mostra; todas ficam na tabela. */
const TIP_TECHNIQUES = 3;
/** Quantas táticas o resumo falado do gráfico diz; todas ficam nos eixos e na lista. */
const SPOKEN_TACTICS = 3;

/** Uma linha da lista das táticas. */
const ROW = 'flex items-start gap-3 px-3 py-1.5 text-sm';

const alerts = (tactic: MitreTactic) => plural(tactic.findings, 'alerta', 'alertas');
const incidents = (tactic: MitreTactic) => plural(tactic.incidents, 'incidente', 'incidentes');
/** O que o gráfico conta: os casos ou, sem eles, os alertas. */
const counted = (tactic: MitreTactic, basis: ShareBasis) =>
  basis === 'cases' ? plural(tactic.cases ?? 0, 'caso', 'casos') : alerts(tactic);

/** O que a dica mostra, em texto: o nome falado do eixo. */
function describe({ tactic, label, share }: TacticShare, basis: ShareBasis): string {
  const part = tactic.findings > 0 ? ` (${spokenPart(share)} do total)` : '';
  const techniques = tactic.techniques.slice(0, TIP_TECHNIQUES).map((technique) => technique.id);
  const detail = basis === 'cases' ? `, ${alerts(tactic)}` : '';
  return [
    `${label} (${tactic.id}): ${counted(tactic, basis)}${part}${detail}, ${incidents(tactic)}.`,
    techniques.length > 0 && `Técnicas mais vistas: ${formatList(techniques)}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** O resumo falado do gráfico: quantas táticas têm alerta e as maiores. */
function summarize(
  shares: readonly TacticShare[],
  ranked: readonly TacticShare[],
  basis: ShareBasis,
  linked: boolean,
): string {
  const top = ranked
    .slice(0, SPOKEN_TACTICS)
    .map((item) => `${item.label}, ${counted(item.tactic, basis)} (${spokenPart(item.share)})`)
    .join('; ');
  const keys = linked
    ? 'Use as setas para percorrer as táticas e Enter para ver os alertas da tática.'
    : 'Use as setas para percorrer as táticas.';
  return `Gráfico de radar das táticas do MITRE ATT&CK: ${ranked.length} de ${shares.length} com alertas${
    ranked.length > SPOKEN_TACTICS ? '. As maiores' : ''
  }: ${top}. ${keys}`;
}

function TacticTip({ item: { tactic, label, share }, basis }: { item: TacticShare; basis: ShareBasis }) {
  return (
    <>
      <p>
        <strong className="font-semibold text-foreground">{label}</strong>{' '}
        <span className="text-muted-foreground">{tactic.id}</span>
      </p>
      <p>
        <strong className="font-semibold text-foreground">{formatPart(share)}</strong>{' '}
        <span className="text-muted-foreground">
          {basis === 'cases' && <>· {counted(tactic, basis)} </>}· {alerts(tactic)} · {incidents(tactic)}
        </span>
      </p>
      {tactic.techniques.length > 0 && (
        <p className="text-muted-foreground">
          Técnicas:
          {tactic.techniques.slice(0, TIP_TECHNIQUES).map((technique) => (
            <Fragment key={technique.id}>
              {' '}
              {/* Cada técnica inteira na mesma linha, quando cabe. */}
              <span className="inline-block wrap-anywhere">
                {technique.id} ({formatCount(technique.findings)})
              </span>
            </Fragment>
          ))}
        </p>
      )}
    </>
  );
}

/**
 * As 14 táticas do MITRE ATT&CK num gráfico de radar, na ordem da cadeia de ataque, com a participação de cada uma nos
 * casos do período (sem eles, nos alertas), e ao lado as táticas vistas, da maior para a menor, com os dois números. Com
 * `tacticHref`, cada tática com alerta leva à lista filtrada por ela. Sem nenhum alerta com tática não há o que desenhar: quem chama mostra a explicação.
 */
export function MitreRadar({
  tactics,
  tacticHref,
}: {
  tactics: readonly MitreTactic[];
  tacticHref?: (tactic: MitreTactic) => string;
}) {
  const titleId = useId();
  const listId = useId();
  const basis = shareBasis(tactics);
  const shares = useMemo(() => tacticShares(tactics, basis), [tactics, basis]);
  const ranked = rankedTactics(shares);
  if (ranked.length === 0) return null;

  const hrefOf = (tactic: MitreTactic) => (tactic.findings > 0 ? tacticHref?.(tactic) : undefined);
  const axes = shares.map((item): SpiderAxis => {
    const to = hrefOf(item.tactic);
    return {
      key: item.tactic.id,
      lines: wrapLabel(item.label),
      // Sem nome curto (uma tática nova no relatório), o código dela, que sempre cabe.
      shortLines: TACTIC_SHORT_LINES[item.tactic.name] ?? [item.tactic.id],
      share: item.share,
      description: describe(item, basis),
      tip: <TacticTip item={item} basis={basis} />,
      ...(to !== undefined && { to }),
    };
  });

  return (
    <section aria-labelledby={titleId} className="@container min-w-0 space-y-3">
      <div className="space-y-1">
        <h3 id={titleId} className="text-sm font-semibold">
          {basis === 'cases' ? 'Casos por tática' : 'Alertas por tática'}
        </h3>
        <p className="text-xs text-muted-foreground">
          {basis === 'cases'
            ? 'Participação de cada tática nos casos do período: muitos alertas iguais são um caso só. Um caso com duas táticas conta nas duas, e o alerta sem caso (tratado antes deles ou esperado por exceção) só aparece nos alertas.'
            : 'Participação de cada tática no período. Um alerta com duas táticas conta nas duas.'}{' '}
          Escala ampliada perto do centro, para as participações pequenas aparecerem.
        </p>
      </div>
      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,41.5rem)_18rem] @6xl:grid-cols-[minmax(0,41.5rem)_26rem]">
        {/* Ao lado de uma lista mais alta, o quadro acompanha a altura dela, com o gráfico no meio. */}
        <div className="flex min-w-0 items-center rounded-md border bg-surface p-2 sm:p-3">
          <SpiderChart
            className="mx-auto max-w-[40rem]"
            label={summarize(shares, ranked, basis, tacticHref !== undefined)}
            axes={axes}
            touchHint="Toque de novo para ver os alertas."
          />
        </div>
        <div className="min-w-0 space-y-2">
          <h4 id={listId} className="text-sm font-medium text-muted-foreground">
            Táticas com alertas
          </h4>
          {/* Embaixo do gráfico, em duas colunas quando cabem; ao lado dele, numa só. */}
          <ol
            aria-labelledby={listId}
            className="grid overflow-hidden rounded-md border bg-surface @2xl:grid-cols-2 @4xl:grid-cols-1"
          >
            {ranked.map((item) => {
              const to = hrefOf(item.tactic);
              const body = <RankedTactic item={item} basis={basis} />;
              return (
                <li
                  key={item.tactic.id}
                  className="-mt-px min-w-0 border-t @2xl:even:border-l @4xl:even:border-l-0"
                >
                  {to === undefined ? (
                    <div className={ROW}>{body}</div>
                  ) : (
                    <Link
                      to={to}
                      className={cn(ROW, 'hover:bg-foreground/5 focus-visible:-outline-offset-2')}
                    >
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}

/** Uma linha da lista: o nome, o código, os incidentes e a técnica mais vista, com os alertas e o percentual. */
function RankedTactic({ item: { tactic, label, share }, basis }: { item: TacticShare; basis: ShareBasis }) {
  const top = tactic.techniques[0];
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block font-medium wrap-anywhere">{label}</span>{' '}
        <span className="block text-xs text-muted-foreground">
          {tactic.id} · {basis === 'cases' && <>{alerts(tactic)} · </>}
          {incidents(tactic)}
          {top && <> · {top.id}</>}
        </span>{' '}
      </span>
      <span className="shrink-0 text-right tabular-nums">
        <span className="block font-medium">{counted(tactic, basis)}</span>{' '}
        <span className="block text-xs text-muted-foreground">{formatPart(share)}</span>
      </span>
    </>
  );
}
