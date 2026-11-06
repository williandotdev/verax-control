import { useState } from 'react';
import { MiniBars } from '@/components/charts/mini-bars';
import { StatTile } from '@/components/charts/stat-tile';
import { DataTable } from '@/components/data-table';
import { DecisionCard } from '@/components/security/decision-card';
import { ScoreMeter } from '@/components/security/score-meter';
import { Semaphore } from '@/components/security/semaphore';
import { SeverityBadge } from '@/components/security/severity-badge';
import { SourceHealthRow } from '@/components/security/source-health';
import { Timeline } from '@/components/security/timeline';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card } from '@/components/ui/card';
import { SEVERITIES, type Severity } from '@/design/severity';
import { ApiRequestError } from '@/lib/api-client';
import { formatRelative } from '@/lib/format';
import { CatalogSection } from './catalog-section';

/** Dados fictícios só para o catálogo. */
interface DemoFinding {
  id: string;
  title: string;
  severity: Severity;
  account: string;
}

const DEMO_FINDINGS: DemoFinding[] = Array.from({ length: 42 }, (_, index) => ({
  id: `demo-${index + 1}`,
  title:
    ['Chave de acesso sem rotação', 'Bucket S3 público', 'Login root sem MFA', 'Porta 22 aberta'][
      index % 4
    ] ?? '',
  severity: SEVERITIES[index % 4] ?? 'low',
  account: `11112222${String(3333 + index).padStart(4, '0')}`,
}));

const PAGE_SIZE = 10;

/** Achados por hora fictícios para o minigráfico do catálogo, das 0h às 23h. */
const DEMO_HOURLY = [0, 0, 1, 0, 0, 0, 0, 2, 1, 0, 3, 1, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0];
const DEMO_HOURS = DEMO_HOURLY.map((_, hour) => `${String(hour).padStart(2, '0')}:00`);

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

export function ComponentsShowcase() {
  const [page, setPage] = useState(1);
  const rows = DEMO_FINDINGS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <CatalogSection title="Semáforo" description="Posição da luz, ícone e rótulo dizem o estado.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <Semaphore state="red" reason="1 incidente crítico aberto" />
          </Card>
          <Card>
            <Semaphore state="yellow" reason="Postura abaixo de 70" />
          </Card>
          <Card>
            <Semaphore
              state="green"
              reason="Tudo calmo. Coleta ativa em 4 de 4 fontes, último dado há 2 minutos."
            />
          </Card>
        </div>
      </CatalogSection>

      <CatalogSection title="Selo de severidade">
        <Card className="flex flex-wrap gap-2">
          {SEVERITIES.map((severity) => (
            <SeverityBadge key={severity} severity={severity} />
          ))}
        </Card>
      </CatalogSection>

      <CatalogSection
        title="Medidor de nota"
        description="0 a 100; atenção abaixo de 70 e crítico abaixo de 40."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <ScoreMeter score={86} />
          </Card>
          <Card>
            <ScoreMeter score={62} />
          </Card>
          <Card>
            <ScoreMeter score={23} />
          </Card>
        </div>
      </CatalogSection>

      <CatalogSection
        title="Cartão de número com minigráfico"
        description="Rótulo, valor compacto em pt-BR, uma linha de contexto e, quando há tendência, as colunas por hora na tinta neutra, com a hora atual em destaque. Setas, mouse e toque mostram cada hora; os números ficam em Ver tabela."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Achados nas últimas 24 h"
            value="12"
            detail="9 esperados por exceção"
            link={{ to: '/catalogo', label: 'Ver achados' }}
          >
            <MiniBars
              title="Achados por hora (exemplo)"
              values={DEMO_HOURLY}
              labels={DEMO_HOURS}
              unit={{ one: 'achado', many: 'achados' }}
            />
          </StatTile>
          <StatTile label="Tempo até detectar" value="4 min" detail="Mediana de 24 h." />
          <StatTile label="Agentes online" value="18 de 20" detail="2 agentes sem conexão agora" />
          <StatTile label="Eventos lidos no mês" value="1,2 mi" detail="AWS 1,1 mi · GCP 80,1 mil" />
        </div>
      </CatalogSection>

      <CatalogSection
        title="Saúde da fonte"
        description="Estado da coleta com ícone de forma própria e rótulo: coletando (ok), atrasada (médio), parada (alto); aguardando e não configurada na tinta discreta."
      >
        <Card>
          <ul className="divide-y">
            <li>
              <SourceHealthRow
                name="AWS"
                description="CloudTrail, GuardDuty e WAF, pelo Wazuh"
                state="collecting"
                lastDataAt={minutesAgo(2)}
                note={`último alerta ${formatRelative(minutesAgo(3 * 24 * 60))}`}
              />
            </li>
            <li>
              <SourceHealthRow name="Cloudflare" state="delayed" lastDataAt={minutesAgo(45)} />
            </li>
            <li>
              <SourceHealthRow name="GCP" state="stalled" lastDataAt={minutesAgo(30 * 60)} />
            </li>
            <li>
              <SourceHealthRow name="Agentes nas instâncias" state="waiting" lastDataAt={null} />
            </li>
            <li>
              <SourceHealthRow name="Postura e inventário" state="not_configured" lastDataAt={null} />
            </li>
          </ul>
        </Card>
      </CatalogSection>

      <CatalogSection title="Card de decisão">
        <div className="grid gap-4 sm:grid-cols-2">
          <DecisionCard
            severity="critical"
            title="Incidente sem responsável"
            description="Login root sem MFA seguido de criação de chave de acesso."
            meta="Cliente Demo Alfa · conta 111122223333 · há 12 min"
            actionLabel="Assumir incidente"
            onAction={() => undefined}
            secondaryLabel="Ver detalhes"
            onSecondary={() => undefined}
          />
          <DecisionCard
            severity="high"
            title="Achado novo fora de incidente"
            description="Security group com a porta 22 aberta para a internet."
            actionLabel="Triar achado"
            onAction={() => undefined}
            busy
          />
        </div>
      </CatalogSection>

      <CatalogSection
        title="Tabela com filtro e paginação"
        description="Paginação feita na API; a tabela mostra a página recebida."
      >
        <DataTable
          caption="Achados de exemplo"
          columns={[
            {
              key: 'severity',
              header: 'Severidade',
              cell: (row) => <SeverityBadge severity={row.severity} />,
            },
            { key: 'title', header: 'Achado', cell: (row) => row.title },
            {
              key: 'account',
              header: 'Conta',
              cell: (row) => <span className="font-mono">{row.account}</span>,
            },
          ]}
          rows={rows}
          rowKey={(row) => row.id}
          page={page}
          pageSize={PAGE_SIZE}
          total={DEMO_FINDINGS.length}
          onPageChange={setPage}
          filters={
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Severidade
              <select className="h-9 rounded-md border bg-surface-raised px-2 text-sm text-foreground">
                <option>Todas</option>
                {SEVERITIES.map((severity) => (
                  <option key={severity}>{severity}</option>
                ))}
              </select>
            </label>
          }
        />
      </CatalogSection>

      <CatalogSection title="Linha do tempo">
        <Card>
          <Timeline
            events={[
              {
                id: '1',
                at: '2026-10-31T13:02:11Z',
                title: 'Login do usuário root sem MFA',
                severity: 'critical',
                source: 'CloudTrail · 203.0.113.7',
              },
              {
                id: '2',
                at: '2026-10-31T13:04:40Z',
                title: 'Chave de acesso criada',
                severity: 'high',
                description: 'CreateAccessKey para o usuário deploy-bot.',
                source: 'CloudTrail',
              },
              { id: '3', at: '2026-10-31T13:20:00Z', title: 'Incidente assumido por Ana', source: 'Painel' },
            ]}
          />
        </Card>
      </CatalogSection>

      <CatalogSection title="Estados">
        <div className="grid gap-4 sm:grid-cols-3">
          <EmptyState title="Nenhum incidente aberto" description="Quando houver, eles aparecem aqui." />
          <Card>
            <LoadingState />
          </Card>
          <ErrorState
            error={new ApiRequestError(500, 'x', undefined, 'req-0b6f1f7e')}
            onRetry={() => undefined}
          />
        </div>
      </CatalogSection>
    </>
  );
}
