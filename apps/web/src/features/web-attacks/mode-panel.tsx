import {
  WEB_MULTIPLIER_BOUNDS,
  type WebObservation,
  type WebSourceHealth,
  type WebSourceSettings,
} from '@verax/shared';
import { type FormEvent, useRef, useState } from 'react';
import { SeverityBadge } from '@/components/security/severity-badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { useNow } from '@/features/admin/aws-hooks';
import { Notice, ToneBadge } from '@/features/admin/aws-ui';
import { formatMinute, plural } from '@/lib/format';
import { formatMultiplier, formatRemaining, MULTIPLIER_ERROR, parseMultiplier } from './web-forms';
import { useUpdateWebSettings } from './web-logs-api';
import { severityOfLevel, webLogsErrorText, webRuleText, webRuleTitle } from './web-logs-labels';

/** Da regra mais grave para a menos grave; no mesmo nível, a que abriria mais alertas. */
function sortedRules(observation: WebObservation): WebObservation['rules'] {
  return [...observation.rules].sort(
    (a, b) => b.level - a.level || b.findings - a.findings || a.ruleId.localeCompare(b.ruleId),
  );
}

/** O que a observação contou: por regra e nível, quantos alertas abririam, e de quando a quando. */
export function ObservationSummary({ observation }: { observation: WebObservation }) {
  const rules = sortedRules(observation);
  const total = rules.reduce((sum, rule) => sum + rule.findings, 0);
  if (rules.length === 0) {
    return (
      <p>
        Desde {formatMinute(observation.since)}, nada teria virado alerta. Nenhum ataque que passe dos limites
        das regras apareceu neste balanceador.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p>
        Desde {formatMinute(observation.since)},{' '}
        <strong>
          {observation.truncated ? 'pelo menos ' : ''}
          {plural(total, 'alerta teria sido aberto', 'alertas teriam sido abertos')}
        </strong>
        :
      </p>
      <ul className="divide-y rounded-md border">
        {rules.map((rule) => {
          const what = webRuleText(rule.ruleId);
          return (
            <li key={`${rule.ruleId}|${rule.level}`} className="space-y-1 px-3 py-2">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <SeverityBadge severity={severityOfLevel(rule.level)} />
                <span className="min-w-0 font-medium wrap-anywhere">{webRuleTitle(rule.ruleId)}</span>
              </p>
              {what !== null && <p className="text-xs text-muted-foreground">{what}</p>}
              <p className="text-xs">
                {observation.truncated ? 'pelo menos ' : ''}
                {plural(rule.findings, 'alerta', 'alertas')}, de {formatMinute(rule.firstSeenAt)} a{' '}
                {formatMinute(rule.lastSeenAt)} (regra {rule.ruleId}, nível {rule.level})
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * O modo do balanceador: observando (conta, sem abrir alerta) ou alertando. Os primeiros 3 dias são sempre de observação; depois
 * dela, quem administra decide quando começar a alertar, vendo antes o que teria sido aberto. Nada muda de modo sozinho.
 */
export function ModePanel({
  sourceId,
  name,
  settings,
  health,
  canWrite,
}: {
  sourceId: string;
  name: string;
  settings: WebSourceSettings;
  health: WebSourceHealth | null;
  canWrite: boolean;
}) {
  const now = useNow(30_000);
  const update = useUpdateWebSettings(sourceId);
  const [confirming, setConfirming] = useState<'alert' | 'observe' | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const until = settings.observeUntil === null ? null : Date.parse(settings.observeUntil);
  const remaining = until === null ? 0 : Math.max(0, until - now);
  const observing = settings.mode === 'observe';
  const observation = health?.observation ?? null;

  const ask = (mode: 'alert' | 'observe') => {
    update.reset();
    setConfirming(mode);
  };
  const confirm = () => {
    if (confirming === null) return;
    update.mutate({ mode: confirming }, { onSuccess: () => setConfirming(null) });
  };

  return (
    <section aria-label={`Modo do ${name}`} className="space-y-3">
      <div ref={status} tabIndex={-1} role="status" className="space-y-1 focus:outline-none">
        {observing ? (
          <>
            <ToneBadge tone={remaining > 0 ? 'progress' : 'low'}>
              {remaining > 0
                ? `Observando: faltam ${formatRemaining(remaining)} da observação obrigatória.`
                : 'Observando: a observação obrigatória terminou.'}
            </ToneBadge>
            <p className="text-sm text-muted-foreground">
              O Verax lê e conta, mas não abre alerta nem manda e-mail deste balanceador.{' '}
              {until !== null && remaining > 0
                ? `A partir de ${formatMinute(new Date(until))}, você decide quando ele passa a alertar. Nada muda sozinho.`
                : 'Quando quiser, comece a alertar. Nada muda sozinho.'}
            </p>
          </>
        ) : (
          <>
            <ToneBadge tone="ok">Alertando.</ToneBadge>
            <p className="text-sm text-muted-foreground">
              Os ataques detectados neste balanceador abrem alertas em Detecções. Os de severidade alta e
              crítica também vão por e-mail.
            </p>
          </>
        )}
      </div>

      {observing && (
        <div className="space-y-2 text-sm">
          <h6 className="font-semibold">O que teria virado alerta</h6>
          {observation === null ? (
            <p className="text-muted-foreground">
              Ainda sem contagem: ela aparece depois da primeira leitura do log, em até 15 minutos.
            </p>
          ) : (
            <ObservationSummary observation={observation} />
          )}
        </div>
      )}

      {canWrite && (
        <div className="space-y-1">
          <Button
            type="button"
            size="sm"
            variant={observing ? 'primary' : 'secondary'}
            disabled={observing && remaining > 0}
            aria-describedby={observing && remaining > 0 ? `${sourceId}-espera` : undefined}
            aria-label={`${observing ? 'Começar a alertar' : 'Voltar a observar'}: ${name}`}
            onClick={() => ask(observing ? 'alert' : 'observe')}
          >
            {observing ? 'Começar a alertar' : 'Voltar a observar'}
          </Button>
          {observing && remaining > 0 && (
            <p id={`${sourceId}-espera`} className="text-xs text-muted-foreground">
              O botão libera no fim da observação.
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => setConfirming(open ? confirming : null)}
        title={confirming === 'alert' ? `Começar a alertar: ${name}` : `Voltar a observar: ${name}`}
        description={
          confirming === 'alert'
            ? 'A partir da próxima leitura, os ataques detectados abrem alertas em Detecções. Os de severidade alta e crítica também mandam e-mail. Dá para voltar a observar a qualquer momento.'
            : 'O balanceador continua sendo lido e contado, mas deixa de abrir alerta e de mandar e-mail. Os alertas já abertos continuam em Detecções.'
        }
        confirmLabel={confirming === 'alert' ? 'Começar a alertar' : 'Voltar a observar'}
        busyLabel="Mudando…"
        danger={confirming === 'observe'}
        busy={update.isPending}
        error={update.error ? webLogsErrorText(update.error) : null}
        onConfirm={confirm}
        fallbackFocus={status}
      >
        {confirming === 'alert' ? (
          <>
            <p className="font-semibold">O que teria virado alerta até aqui</p>
            {observation === null ? (
              <p>Não há contagem da observação: não dá para prever quantos alertas virão.</p>
            ) : (
              <ObservationSummary observation={observation} />
            )}
            <p className="text-muted-foreground">
              São muitos? Antes de começar, inclua as suas fontes confiáveis, declare as rotas de login ou
              aumente o multiplicador dos limites.
            </p>
          </>
        ) : undefined}
      </ConfirmDialog>
    </section>
  );
}

const { min: MIN, max: MAX } = WEB_MULTIPLIER_BOUNDS;

/** O multiplicador dos limites das regras deste balanceador. */
export function MultiplierForm({
  sourceId,
  name,
  settings,
  canWrite,
}: {
  sourceId: string;
  name: string;
  settings: WebSourceSettings;
  canWrite: boolean;
}) {
  const update = useUpdateWebSettings(sourceId);
  const [text, setText] = useState(() => formatMultiplier(settings.thresholdMultiplier));
  const [invalid, setInvalid] = useState(false);
  const value = parseMultiplier(text);
  const changed = value !== null && value !== settings.thresholdMultiplier;
  // O que está gravado mudou (por outra pessoa): o campo que ninguém mexeu acompanha.
  const [base, setBase] = useState(settings.thresholdMultiplier);
  if (base !== settings.thresholdMultiplier) {
    setBase(settings.thresholdMultiplier);
    if (value === base) setText(formatMultiplier(settings.thresholdMultiplier));
  }

  if (!canWrite) {
    return (
      <p className="text-sm">
        Multiplicador dos limites: <strong>{formatMultiplier(settings.thresholdMultiplier)}</strong>
        {settings.thresholdMultiplier === 1 && ' (o padrão)'}.
      </p>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setInvalid(value === null);
    if (value === null || !changed) return;
    update.mutate({ thresholdMultiplier: value });
  };
  return (
    <form onSubmit={submit} noValidate className="space-y-2">
      <Field
        label={`Multiplicador dos limites (${name})`}
        hint={`De ${formatMultiplier(MIN)} a ${formatMultiplier(MAX)}; 1 é o padrão. Com 2, as regras só disparam com o dobro de tentativas; com 0,5, com a metade. Não vale para o caminho sensível respondido, que dispara sempre.`}
        error={invalid && value === null ? MULTIPLIER_ERROR : undefined}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
          update.reset();
        }}
        inputMode="decimal"
        autoComplete="off"
        className="max-w-md"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="secondary" disabled={update.isPending}>
          {update.isPending ? 'Salvando…' : 'Salvar multiplicador'}
        </Button>
        {update.isSuccess && !changed && (
          <p role="status" className="text-sm">
            Salvo: vale na próxima leitura.
          </p>
        )}
      </div>
      {update.error ? (
        <p role="alert" className="text-sm text-critical-text">
          {webLogsErrorText(update.error)}
        </p>
      ) : null}
      {value !== null && value > 1 && (
        <Notice tone="low">
          <p>Um multiplicador alto esconde ataques menores. Prefira declarar uma fonte confiável.</p>
        </Notice>
      )}
    </form>
  );
}
