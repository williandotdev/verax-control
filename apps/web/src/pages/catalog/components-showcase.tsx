import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { DecisionCard } from '@/components/security/decision-card';
import { ScoreMeter } from '@/components/security/score-meter';
import { Semaphore } from '@/components/security/semaphore';
import { SeverityBadge } from '@/components/security/severity-badge';
import { Timeline } from '@/components/security/timeline';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card } from '@/components/ui/card';
import { SEVERITIES, type Severity } from '@/design/severity';
import { ApiRequestError } from '@/lib/api-client';
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
            <Semaphore state="green" reason="Nada pendente" />
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
