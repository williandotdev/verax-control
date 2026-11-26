import { type AwsOnboarding, type AwsSource, type CloudAccount } from '@verax/shared';
import type { ReactNode } from 'react';
import {
  AWS_SOURCE_KIND_TEXTS,
  awsCheckLabel,
  awsCheckText,
  awsSourceHealthText,
  awsSourceName,
  type Tone,
} from '@/features/admin/aws-onboarding-labels';
import { attentionChecks, awsAuthorizedSourceAnchor, groupAwsSources } from '@/features/admin/aws-sources';
import { AWS_ACCOUNT_FACTS_ID, attentionSources } from '@/features/admin/aws-account-view';
import { ToneIcon } from '@/features/admin/aws-ui';
import { awsCollectionErrorHint, CONNECTION_LABELS, connectionHint } from '@/features/admin/labels';
import { cn } from '@/lib/cn';
import { formatRelative, plural } from '@/lib/format';

/** Um item de "O que precisa de atenção": o que é, o motivo numa linha e para onde ir resolver. */
interface AttentionItem {
  key: string;
  tone: Tone;
  title: string;
  detail: string | null;
  /** O `id` do lugar onde estão as ações (a linha da fonte, a conferência, os dados da conta). */
  target: string;
  /** O nome do link, que diz para onde ele leva. */
  goLabel: string;
}

function sourceTitle(source: AwsSource): string {
  const name = awsSourceName(source);
  const kind = AWS_SOURCE_KIND_TEXTS[source.kind].label;
  const where = source.region === 'global' ? '' : ` (${source.region})`;
  return name === '' ? `${kind}${where}` : `${kind} · ${name}${where}`;
}

/**
 * Tudo o que pede alguém, na ordem de gravidade da decisão: o aviso da coleta no nó (é da Verax, e pode parar a leitura
 * dos logs), as conferências da conexão com falha ou pendentes e as fontes autorizadas com problema. Cada item diz o
 * motivo numa linha e leva ao lugar onde estão as ações dele: nenhuma ação (nem confirmação) é repetida aqui.
 */
function attentionItems(account: CloudAccount, onboarding: AwsOnboarding): AttentionItem[] {
  const items: AttentionItem[] = [];
  const collection = awsCollectionErrorHint(account.collectionError);
  if (collection !== null) {
    items.push({
      key: 'coleta-no-no',
      tone: 'medium',
      title: 'Coleta no nó',
      detail: collection,
      target: AWS_ACCOUNT_FACTS_ID,
      goLabel: 'Ver a coleta no nó',
    });
  }
  for (const check of attentionChecks(onboarding)) {
    items.push({
      key: `conferencia-${check.id}`,
      tone: check.status === 'failed' ? 'critical' : 'medium',
      title: `Conferência: ${awsCheckLabel(check.id, onboarding.credentialMode)}`,
      detail: awsCheckText(check).text,
      target: 'aws-conferencias',
      goLabel: 'Ver a conferência',
    });
  }
  for (const source of attentionSources(onboarding)) {
    const health = awsSourceHealthText(source);
    items.push({
      key: source.id,
      tone: health.tone,
      title: sourceTitle(source),
      detail: health.detail === null ? health.label : `${health.label}. ${health.detail}`,
      target: awsAuthorizedSourceAnchor(source.id),
      goLabel: 'Ver na tabela',
    });
  }
  return items;
}

/** A linha de estado do topo: a conexão e, sem contradizer o selo, quantas fontes pedem atenção. */
function statusLine(account: CloudAccount, sources: number): { tone: Tone; text: string } {
  if (account.status !== 'active') {
    return { tone: 'idle', text: 'Monitoramento desativado: esta conta não está sendo monitorada.' };
  }
  const label = CONNECTION_LABELS[account.connection];
  if (account.connection !== 'connected') {
    return {
      tone: account.connection === 'error' ? 'critical' : 'medium',
      // "Aguardando…" já começa pelo estado; o erro ganha o nome dele na frente.
      text: account.connection === 'error' ? `${label}: ${connectionHint(account)}` : connectionHint(account),
    };
  }
  return sources > 0
    ? {
        tone: 'medium',
        text: `${label}, com ${plural(sources, 'fonte que precisa', 'fontes que precisam')} de atenção`,
      }
    : { tone: 'ok', text: label };
}

function Figure({
  label,
  value,
  note,
  highlight = false,
}: {
  label: string;
  value: ReactNode;
  note: string;
  highlight?: boolean;
}) {
  return (
    <div className={cn('rounded-md border p-3', highlight && 'border-medium/50 bg-medium/10')}>
      <dt className="text-sm">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      <dd className="text-xs text-muted-foreground">{note}</dd>
    </div>
  );
}

/**
 * "Visão geral" do detalhe da conta AWS já conectada (E-04 da auditoria de UX): numa tela, o estado da conta numa linha,
 * quatro números, a lista do que pede alguém (com o motivo e o caminho até as ações) e o resumo do que é lido
 * normalmente. Nada sai do detalhe: o resto fica nas outras abas, e cada item daqui leva até lá.
 */
export function AwsAccountOverview({
  account,
  onboarding,
  onShowSources,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  /** Abre a aba "Fontes lidas". */
  onShowSources: () => void;
}) {
  const { authorized, groups, logGroups } = groupAwsSources(onboarding.sources);
  const troubled = attentionSources(onboarding);
  const troubledIds = new Set(troubled.map((source) => source.id));
  const healthy = authorized.filter((source) => !troubledIds.has(source.id));
  const items = attentionItems(account, onboarding);
  const status = statusLine(account, troubled.length);
  const missingPermission = troubled.filter((source) => source.state === 'permission_error').length;
  const checksOk = onboarding.checks.filter((check) => check.status === 'ok').length;
  const checksFailed = onboarding.checks.filter((check) => check.status === 'failed').length;
  const checksPending = onboarding.checks.filter((check) => check.status === 'pending').length;

  const byKind = new Map<string, number>();
  for (const source of healthy) {
    const label = AWS_SOURCE_KIND_TEXTS[source.kind].label;
    byKind.set(label, (byKind.get(label) ?? 0) + 1);
  }
  const lastEvent = healthy
    .map((source) => source.health.lastEventAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  const facts = [
    account.lastCollectedAt
      ? `última leitura ${formatRelative(account.lastCollectedAt)}`
      : 'nenhuma leitura ainda',
    account.regions.length > 0 ? account.regions.join(', ') : null,
  ].filter((part): part is string => part !== null);

  return (
    <section aria-labelledby="aws-visao-geral-titulo" className="space-y-4">
      <h3 id="aws-visao-geral-titulo" className="sr-only">
        Visão geral da conta
      </h3>
      <p className="flex items-start gap-2 text-sm">
        <ToneIcon tone={status.tone} className="mt-0.5" />
        <span>
          <span className="font-medium">{status.text}</span>
          <span className="text-muted-foreground"> · {facts.join(' · ')}</span>
        </span>
      </p>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Figure
          label="Fontes lidas"
          value={authorized.length}
          note={`${healthy.length} em dia ou começando`}
        />
        <Figure
          label="Precisam de atenção"
          value={troubled.length}
          note={
            missingPermission > 0
              ? `${missingPermission} por falta de permissão`
              : troubled.length > 0
                ? 'paradas ou com erro de leitura'
                : 'nenhuma fonte com problema'
          }
          highlight={troubled.length > 0}
        />
        <Figure
          label="Para autorizar"
          value={groups.available.length}
          note={
            logGroups.length > 0
              ? `e ${plural(logGroups.length, 'grupo de logs', 'grupos de logs')}`
              : 'nenhum grupo de logs'
          }
        />
        <Figure
          label="Conferências da conexão"
          value={`${checksOk} de ${onboarding.checks.length}`}
          note={`${checksFailed} com problema · ${plural(checksPending, 'pendente', 'pendentes')}`}
        />
      </dl>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">O que precisa de atenção ({items.length})</h4>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nada pede atenção nesta conta agora.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((item) => (
              <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 p-3 text-sm">
                <ToneIcon tone={item.tone} className="mt-0.5" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="break-words font-medium">{item.title}</p>
                  {item.detail && <p className="text-xs text-muted-foreground">{item.detail}</p>}
                </div>
                <a
                  href={`#${item.target}`}
                  className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium hover:bg-foreground/[0.04] sm:min-h-9"
                >
                  {item.goLabel}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold">Lendo normalmente ({healthy.length})</h4>
          {authorized.length > 0 && (
            <button type="button" onClick={onShowSources} className="min-h-11 text-sm underline sm:min-h-0">
              Ver {plural(authorized.length, 'fonte', 'fontes')}, com volume e atraso
            </button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {healthy.length === 0
            ? 'Nenhuma fonte autorizada está sendo lida normalmente agora.'
            : `${[...byKind].map(([label, count]) => `${label}: ${count}`).join(' · ')}.${
                lastEvent ? ` Último evento ${formatRelative(lastEvent)}.` : ''
              }`}
        </p>
      </div>
    </section>
  );
}
