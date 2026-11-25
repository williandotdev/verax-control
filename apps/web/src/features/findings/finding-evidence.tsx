import { type FindingDetail, type FindingWebEvidence, RAW_EVENT_RETENTION_DAYS } from '@verax/shared';
import { Copy } from 'lucide-react';
import { Fragment, type ReactNode, useId, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  clientClassText,
  EVIDENCE_COUNTERS,
  evidenceNoteText,
  probeFamilyText,
  routeText,
  statusText,
  uaFamilyText,
} from '@/features/web-attacks/evidence-labels';
import { webRuleText } from '@/features/web-attacks/web-logs-labels';
import { formatCount, formatMinute, formatTimestamp, plural } from '@/lib/format';
import { useFindingEvidence } from './findings-api';

/**
 * A evidência de um ataque web visto nos logs do balanceador: contagens, caminhos mascarados, endereços, amostras e onde está a
 * linha original, no S3 do próprio cliente. Tudo o que veio da internet (caminhos, User-Agent, chaves) é mostrado como texto, por
 * um schema estrito, e nunca como HTML nem como link.
 */

function Block({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-1.5">
      <h4 id={id} className="text-sm font-medium">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 font-medium wrap-anywhere">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Barras horizontais com o rótulo e o número de cada uma: a barra só reforça, o número está escrito. */
function Bars({
  label,
  items,
}: {
  label: string;
  items: readonly { key: string; name: ReactNode; count: number; note?: string }[];
}) {
  const largest = Math.max(1, ...items.map((item) => item.count));
  return (
    <ul aria-label={label} className="space-y-1.5 text-xs">
      {items.map((item) => (
        <li key={item.key} className="space-y-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 wrap-anywhere">{item.name}</span>
            <span className="shrink-0 tabular-nums">
              {formatCount(item.count)}
              {item.note !== undefined && <span className="text-muted-foreground"> {item.note}</span>}
            </span>
          </div>
          <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div
              className="h-full rounded-full bg-foreground/60"
              style={{ width: `${Math.max(1, (item.count / largest) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Chips({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item} className="rounded border px-2 py-0.5 text-xs wrap-anywhere">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** A chave do arquivo no bucket do cliente, com o botão de copiar: texto, nunca um link. */
function Pointer({ objectKey, minute }: { objectKey: string; minute: string }) {
  const [copied, setCopied] = useState(false);
  const at = formatMinute(minute);
  return (
    <li className="space-y-1 px-3 py-2">
      <p className="text-xs text-muted-foreground">Minuto de {at}</p>
      <p className="font-mono text-xs break-all">{objectKey}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void navigator.clipboard?.writeText(objectKey).then(() => setCopied(true))}
        aria-label={`Copiar a chave do arquivo do minuto de ${at}`}
      >
        <Copy aria-hidden />
        {copied ? 'Copiada' : 'Copiar a chave'}
      </Button>
    </li>
  );
}

function Counters({ evidence }: { evidence: FindingWebEvidence }) {
  const { counters, blockedPercent, truncated } = evidence;
  const rows = EVIDENCE_COUNTERS.filter(({ key }) => key === 'requests' || counters[key] > 0).map(
    ({ key, label }) =>
      [
        label,
        key === 'blocked' && blockedPercent > 0
          ? `${formatCount(counters[key])} (${blockedPercent}%)`
          : `${truncated ? 'pelo menos ' : ''}${formatCount(counters[key])}`,
      ] as const,
  );
  return <Facts rows={rows} />;
}

/** Uma amostra por linha, sem tabela: no painel estreito, a resposta e os bytes ficariam escondidos. */
function Samples({ samples }: { samples: FindingWebEvidence['samples'] }) {
  return (
    <ul aria-label="Amostras das requisições" className="divide-y rounded-md border text-xs">
      {samples.map((sample, index) => (
        <li key={`${sample.at}|${index}`} className="space-y-0.5 px-3 py-1.5">
          <p className="font-mono break-all">
            {sample.method} {sample.path}
          </p>
          <p className="text-muted-foreground tabular-nums">
            {formatTimestamp(sample.at)} ·{' '}
            {sample.status === 0 ? 'sem resposta' : `resposta ${sample.status}`} ·{' '}
            {plural(sample.bytes, 'byte', 'bytes')}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** A evidência inteira, já validada. */
export function EvidenceView({
  evidence,
  samplesPurgedAt,
}: {
  evidence: FindingWebEvidence;
  samplesPurgedAt: string | null;
}) {
  const what = webRuleText(evidence.ruleId);
  const route = routeText(evidence.routeKind, evidence.routeSemantics);
  const facts: [string, ReactNode][] = [];
  if (evidence.client !== null) facts.push(['Endereço', <code key="c">{evidence.client}</code>]);
  if (evidence.clientClass !== null && evidence.clientClass !== 'direct') {
    facts.push(['Origem', clientClassText(evidence.clientClass)]);
  }
  if (evidence.host !== null) facts.push(['Host', <code key="h">{evidence.host}</code>]);
  if (evidence.route !== null) {
    facts.push([
      'Rota',
      <Fragment key="r">
        <code>{evidence.route}</code>
        {route !== null && <span className="block text-xs font-normal text-muted-foreground">{route}</span>}
      </Fragment>,
    ]);
  }
  facts.push(['Atividade', `${formatMinute(evidence.firstSeenAt)} a ${formatMinute(evidence.lastSeenAt)}`]);
  facts.push(['Janela contada', `${formatMinute(evidence.windowFrom)} a ${formatMinute(evidence.windowTo)}`]);
  const clients = evidence.counters.clients;
  const expired = samplesPurgedAt !== null;

  return (
    <div className="space-y-4">
      {what !== null && <p className="text-sm">{what}</p>}
      <Facts rows={facts} />
      <Block title="Contagens da janela">
        <Counters evidence={evidence} />
      </Block>

      {evidence.notes.length > 0 && (
        <Block title="O que saber antes de concluir">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {evidence.notes.map((note) => (
              <li key={note}>{evidenceNoteText(note)}</li>
            ))}
          </ul>
        </Block>
      )}

      {evidence.statuses.length > 0 && (
        <Block title="Respostas da aplicação">
          <Bars
            label="Requisições por código de resposta"
            items={evidence.statuses.map(({ status, count }) => ({
              key: status,
              name: statusText(status),
              count,
            }))}
          />
        </Block>
      )}

      {evidence.clients.length > 0 && (
        <Block
          title={`Endereços (${formatCount(evidence.clients.length)} de ${formatCount(Math.max(clients, evidence.clients.length))})`}
        >
          <Bars
            label="Endereços, do mais ativo ao menos ativo"
            items={evidence.clients.map((item) => ({
              key: item.client,
              name: <code>{item.client}</code>,
              count: item.count,
              note: `de ${plural(item.requests, 'requisição', 'requisições')}`,
            }))}
          />
        </Block>
      )}

      {evidence.probeFamilies.length > 0 && (
        <Block title="O que foi procurado">
          <Chips label="Famílias de caminhos sensíveis" items={evidence.probeFamilies.map(probeFamilyText)} />
        </Block>
      )}

      {evidence.routes.length > 0 && (
        <Block title="Caminhos mais pedidos">
          <Bars
            label="Caminhos mais pedidos, mascarados"
            items={evidence.routes.map(({ path, count }) => ({
              key: path,
              name: <code>{path}</code>,
              count,
            }))}
          />
          <p className="text-xs text-muted-foreground">
            Os caminhos são mascarados antes de ser guardados: números, identificadores, e-mails e códigos
            viram marcadores como {'{num}'} e {'{token}'}. A parte depois de ? nunca é guardada.
          </p>
        </Block>
      )}

      {(evidence.userAgents.families.length > 0 || evidence.userAgents.sample !== null) && (
        <Block title="Como se identificou (User-Agent)">
          {evidence.userAgents.families.length > 0 && (
            <Chips label="Famílias de User-Agent" items={evidence.userAgents.families.map(uaFamilyText)} />
          )}
          {evidence.userAgents.sample !== null && (
            <p className="font-mono text-xs break-all">{evidence.userAgents.sample}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Quem ataca escolhe este texto: ele acusa ou descreve, e nunca inocenta.
          </p>
        </Block>
      )}

      {expired ? (
        <p role="note" className="rounded-md border bg-foreground/[0.03] p-3 text-sm">
          As amostras e as indicações dos arquivos expiraram em {formatMinute(samplesPurgedAt)}: elas ficam{' '}
          {RAW_EVENT_RETENTION_DAYS} dias. As contagens acima continuam, pelo histórico do plano. As linhas
          originais seguem no seu S3, pela sua retenção.
        </p>
      ) : (
        <>
          {evidence.samples.length > 0 && (
            <Block title="Amostras, mascaradas">
              <Samples samples={evidence.samples} />
            </Block>
          )}
          {evidence.pointers.length > 0 && (
            <Block title="Onde estão as linhas originais">
              <p className="text-xs text-muted-foreground">
                O Verax não guarda a linha do log. Abra no seu S3 o arquivo abaixo, no bucket do log deste
                balanceador (o nome do bucket está em Contas cloud), e procure pelo minuto.
              </p>
              <ul className="divide-y rounded-md border">
                {evidence.pointers.map((pointer) => (
                  <Pointer key={`${pointer.objectKey}|${pointer.minute}`} {...pointer} />
                ))}
              </ul>
            </Block>
          )}
          {(evidence.samples.length > 0 || evidence.pointers.length > 0) && (
            <p className="text-xs text-muted-foreground">
              As amostras e as indicações dos arquivos ficam {RAW_EVENT_RETENTION_DAYS} dias.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A seção da evidência no detalhe de um alerta do ALB. O nó de antes, que não tem a rota, fica sem ela. */
export function FindingEvidenceSection({ finding }: { finding: Pick<FindingDetail, 'id'> }) {
  const id = useId();
  const query = useFindingEvidence(finding.id);
  if (query.data === null) return null;
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-md border p-3">
      <h3 id={id} className="text-sm font-semibold">
        Evidência
      </h3>
      {query.data === undefined ? (
        query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <LoadingState rows={3} label="Carregando a evidência" />
        )
      ) : query.data.evidence === null ? (
        <p className="text-sm text-muted-foreground">
          Este alerta não tem evidência guardada. As linhas originais estão no seu S3, no bucket do log do
          balanceador, no horário do alerta.
        </p>
      ) : (
        <EvidenceView evidence={query.data.evidence} samplesPurgedAt={query.data.samplesPurgedAt} />
      )}
    </section>
  );
}
