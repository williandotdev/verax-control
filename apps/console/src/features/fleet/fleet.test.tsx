import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeState } from '@/mocks/fake-admin-api';
import { renderConsole } from '@/test/render';

const FAILED_ROLLOUT = '01JD0000000000000000000R01';

/**
 * Versões e a frota sobre a API simulada (`mocks/fake-fleet.ts`, dados FICTÍCIOS): as versões do bucket, a versão de
 * cada nó e site, a revisão com as ondas e a confirmação digitando a versão, e a rodada parada na falha com as
 * operações do responsável.
 */
describe('versões e frota', () => {
  it('a lista: as versões conferidas, a frota agora, quem fica fora e as rodadas', async () => {
    renderConsole('/versoes');
    const releases = await screen.findByRole('table', { name: /Versões promovidas/ });
    const ok = within(releases).getByRole('row', { name: /node-v1\.3\.0/ });
    expect(ok).toHaveTextContent('Conferida, com o painel');
    const missing = within(releases).getByRole('row', { name: /node-v1\.2\.3/ });
    expect(missing).toHaveTextContent('Sem o bundle do painel');
    expect(within(missing).queryByRole('link')).toBeNull();
    // Com uma rodada parada na falha, nada novo é promovido: o caminho é acompanhar a rodada.
    expect(within(ok).queryByRole('link', { name: /Promover/ })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('parada na falha');

    const fleet = await screen.findByRole('table', { name: /Nós da frota/ });
    const cell = within(fleet).getByRole('row', { name: /sp1/ });
    expect(cell).toHaveTextContent('Onda 0: célula da Verax (canária)');
    expect(cell).toHaveTextContent('node-v1.2.3');
    expect(cell).toHaveTextContent('verax: node-v1.2.3');
    expect(screen.getByText(/cliente-demo-e/).closest('li')).toHaveTextContent('Nó parado');

    const rollouts = await screen.findByRole('table', { name: /Rodadas da frota/ });
    expect(within(rollouts).getByRole('row', { name: /node-v1\.2\.3/ })).toHaveTextContent(
      '1 de 2 atualizados, 1 com falha',
    );
  });

  it('a rodada parada na falha: o motivo, retomar, pular e voltar um nó', async () => {
    const state = createFakeState();
    const { user } = renderConsole(`/versoes/rodadas/${FAILED_ROLLOUT}`, state);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A rodada parou em cliente-demo-d');
    expect(alert).toHaveTextContent('node_rolled_back:health_failed');
    expect(alert).toHaveTextContent('O host voltou sozinho para a versão de antes');
    const nodes = screen.getByRole('table', { name: /Nós da rodada/ });
    expect(within(nodes).getByRole('row', { name: /sp1/ })).toHaveTextContent('Atualizado');

    await user.click(screen.getByRole('button', { name: 'Voltar sp1 para node-v1.2.2' }));
    await waitFor(() =>
      expect(within(nodes).getByRole('row', { name: /sp1/ })).toHaveTextContent('voltando para node-v1.2.2'),
    );

    await user.click(screen.getByRole('button', { name: 'Pular cliente-demo-d' }));
    await waitFor(() =>
      expect(within(nodes).getByRole('row', { name: /cliente-demo-d/ })).toHaveTextContent('Pulado'),
    );
    await user.click(screen.getByRole('button', { name: 'Retomar' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Parar a rodada' })).toBeInTheDocument());
    expect(state.fleet.rollouts.get(FAILED_ROLLOUT)?.rollout.state).toBe('running');
  });

  it('promover: a revisão com as ondas, a janela, o lote e a versão digitada', async () => {
    const state = createFakeState();
    state.fleet.rollouts.clear();
    const { user, router } = renderConsole('/versoes', state);
    const releases = await screen.findByRole('table', { name: /Versões promovidas/ });
    await user.click(within(releases).getByRole('link', { name: 'Promover node-v1.3.0 para a frota' }));

    expect(await screen.findByRole('heading', { name: /Onda 0: célula da Verax/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Onda 2: nós dedicados/ })).toBeInTheDocument();
    expect(screen.getByText(/painel: verax/)).toBeInTheDocument();
    expect(screen.getByText('cliente-demo-e', { exact: false }).closest('li')).toHaveTextContent('Nó parado');

    const submit = screen.getByRole('button', { name: 'Promover para a frota' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Janela de manutenção/), '25:00-02:00');
    expect(screen.getByLabelText(/Janela de manutenção/)).toHaveAttribute('aria-invalid', 'true');
    await user.clear(screen.getByLabelText(/Janela de manutenção/));
    await user.type(screen.getByLabelText(/Janela de manutenção/), '02:00-05:00');
    await user.selectOptions(screen.getByLabelText('Nós dedicados ao mesmo tempo'), '2');
    await user.type(screen.getByLabelText(/Digite a versão/), 'node-v1.3.1');
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText(/Digite a versão/));
    await user.type(screen.getByLabelText(/Digite a versão/), 'node-v1.3.0');
    await user.click(submit);

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/versoes\/rodadas\/[0-9A-Z]{26}$/));
    expect(state.fleet.lastRequest).toEqual({
      release: 'node-v1.3.0',
      confirmRelease: 'node-v1.3.0',
      concurrency: 2,
      window: '02:00-05:00',
    });
    expect(await screen.findByText(/janela 02:00-05:00/)).toBeInTheDocument();
  });

  it('a versão sem o bundle do painel não abre a revisão', async () => {
    renderConsole('/versoes/promover/node-v1.2.3');
    expect(await screen.findByRole('alert')).toHaveTextContent('não tem o bundle do painel');
  });
});
