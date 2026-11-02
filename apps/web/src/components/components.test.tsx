import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import { CatalogPage } from '@/pages/catalog/catalog-page';
import { DataTable } from './data-table';
import { DecisionCard } from './security/decision-card';
import { scoreSeverity } from '@/design/score';
import { ScoreMeter } from './security/score-meter';
import { Semaphore } from './security/semaphore';
import { SeverityBadge } from './security/severity-badge';
import { Timeline } from './security/timeline';
import { EmptyState, ErrorState, LoadingState } from './states';

describe('Semaphore', () => {
  it.each([
    ['red', 'Crítico'],
    ['yellow', 'Atenção'],
    ['green', 'Normal'],
  ] as const)('%s: rótulo e nome acessível, com uma única luz acesa', (state, label) => {
    const { container } = render(<Semaphore state={state} reason="motivo de teste" />);
    expect(screen.getByRole('status', { name: `Situação: ${label}. motivo de teste` })).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelectorAll('[data-lit="true"]')).toHaveLength(1);
  });
});

describe('ScoreMeter', () => {
  it('expõe o valor como medidor acessível, com o estado por extenso', () => {
    render(<ScoreMeter score={62} />);
    const meter = screen.getByRole('meter', { name: 'Nota de postura' });
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(meter).toHaveAttribute('aria-valuetext', '62 de 100, em atenção');
    expect(screen.getByText('Em atenção')).toBeInTheDocument();
  });

  it('limita o valor entre 0 e 100', () => {
    render(<ScoreMeter score={140} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });

  it.each([
    [69, 'medium'],
    [70, 'ok'],
    [39, 'critical'],
    [40, 'medium'],
  ] as const)('nota %i é %s (atenção abaixo de 70, crítico abaixo de 40)', (score, severity) => {
    expect(scoreSeverity(score)).toBe(severity);
  });
});

describe('SeverityBadge', () => {
  it('mostra o rótulo em texto (não só a cor)', () => {
    render(<SeverityBadge severity="high" />);
    expect(screen.getByText('Alto')).toBeInTheDocument();
  });
});

describe('DecisionCard', () => {
  it('chama a ação e a ação secundária', async () => {
    const onAction = vi.fn();
    const onSecondary = vi.fn();
    render(
      <DecisionCard
        severity="critical"
        title="Incidente sem responsável"
        description="d"
        actionLabel="Assumir"
        onAction={onAction}
        secondaryLabel="Detalhes"
        onSecondary={onSecondary}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Assumir' }));
    await userEvent.click(screen.getByRole('button', { name: 'Detalhes' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onSecondary).toHaveBeenCalledOnce();
    expect(screen.getByText('Crítico')).toBeInTheDocument();
  });

  it('em andamento, não deixa disparar de novo', () => {
    render(
      <DecisionCard severity="low" title="t" description="d" actionLabel="Agir" onAction={vi.fn()} busy />,
    );
    expect(screen.getByRole('button', { name: 'Agir' })).toBeDisabled();
  });
});

describe('DataTable', () => {
  const columns = [{ key: 'name', header: 'Nome', cell: (row: { id: string; name: string }) => row.name }];
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `Item ${i}` }));

  it('mostra a página recebida, a faixa e navega pela API', async () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        caption="Itens"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        page={2}
        pageSize={10}
        total={35}
        onPageChange={onPageChange}
      />,
    );
    expect(screen.getByRole('table', { name: 'Itens' })).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(11);
    expect(screen.getByText('11–20 de 35')).toBeInTheDocument();
    expect(screen.getByText('Página 2 de 4')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await userEvent.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(onPageChange.mock.calls).toEqual([[3], [1]]);
  });

  it('desabilita a navegação nas pontas', () => {
    render(
      <DataTable
        caption="Itens"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        page={1}
        pageSize={10}
        total={10}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
  });

  it('estados vazio, carregando e erro', async () => {
    const onRetry = vi.fn();
    const props = {
      caption: 'Itens',
      columns,
      rowKey: (r: { id: string }) => r.id,
      page: 1,
      pageSize: 10,
      onPageChange: vi.fn(),
    };
    const { rerender } = render(<DataTable {...props} rows={[]} total={0} emptyTitle="Nenhum item" />);
    expect(screen.getByText('Nenhum item')).toBeInTheDocument();

    rerender(<DataTable {...props} rows={undefined} total={0} loading />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');

    rerender(
      <DataTable
        {...props}
        rows={undefined}
        total={0}
        error={new ApiRequestError(403, 'x')}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Sem permissão para acessar isto.');
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('Timeline', () => {
  it('mostra data, título, origem e a severidade também em texto', () => {
    render(
      <Timeline
        events={[
          {
            id: '1',
            at: '2026-10-31T13:02:11Z',
            title: 'Login root sem MFA',
            severity: 'critical',
            source: 'CloudTrail',
          },
        ]}
      />,
    );
    expect(screen.getByText('Login root sem MFA')).toBeInTheDocument();
    expect(screen.getByText('(severidade Crítico)', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('CloudTrail')).toBeInTheDocument();
    expect(screen.getByRole('listitem').querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-10-31T13:02:11.000Z',
    );
  });
});

describe('estados', () => {
  it('erro mostra o código para o suporte, sem detalhe técnico', () => {
    render(
      <ErrorState error={new ApiRequestError(500, 'TypeError: x is undefined', undefined, 'req-123')} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('O servidor não conseguiu concluir a operação.');
    expect(screen.getByText('Código para o suporte: req-123')).toBeInTheDocument();
    expect(screen.queryByText(/TypeError/)).not.toBeInTheDocument();
  });

  it('vazio e carregando', () => {
    render(
      <>
        <EmptyState title="Vazio" description="Nada aqui" />
        <LoadingState label="Buscando" />
      </>,
    );
    expect(screen.getByText('Vazio')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Buscando…');
  });
});

describe('catálogo', () => {
  it('mostra todos os componentes de segurança', () => {
    render(<CatalogPage />);
    for (const name of [
      'Semáforo',
      'Selo de severidade',
      'Medidor de nota',
      'Card de decisão',
      'Tabela com filtro e paginação',
      'Linha do tempo',
      'Estados',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('meter')).toHaveLength(3);
  });
});
