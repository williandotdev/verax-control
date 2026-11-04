import { describe, expect, it } from 'vitest';
import type { TenantRecord, TenantState } from '../tenants/tenant.schema.js';
import { buildStatusView } from './status-view.js';

const DOMAINS = {
  PANEL_DOMAIN_SUFFIX: 'control.veraxsistemas.com.br',
  API_DOMAIN_PREFIX: 'api-',
  CLOUDFLARE_ZONE_NAME: 'veraxsistemas.com.br',
};

function tenant(state: TenantState, extra: Partial<TenantRecord> = {}): TenantRecord {
  return { id: '01JBZZZZZZZZZZZZZZZZZZZZZZ', slug: 'cliente-demo-a', state, ...extra } as TenantRecord;
}

const PANEL = 'https://cliente-demo-a.control.veraxsistemas.com.br';
const API = 'https://api-cliente-demo-a.veraxsistemas.com.br';

describe('buildStatusView (plano §4g)', () => {
  it('compra ainda sem cliente e pending: nada além do estado; o boleto só em pending', () => {
    expect(buildStatusView(undefined, DOMAINS)).toEqual({
      state: 'pending',
      step: null,
      etaMinutes: null,
      panelUrl: null,
      apiUrl: null,
      revealAvailable: false,
    });
    expect(buildStatusView(tenant('pending'), DOMAINS, 'https://payments.stripe.com/boleto/x')).toMatchObject(
      {
        state: 'pending',
        boletoUrl: 'https://payments.stripe.com/boleto/x',
        panelUrl: null,
      },
    );
    expect(
      buildStatusView(tenant('active'), DOMAINS, 'https://payments.stripe.com/boleto/x'),
    ).not.toHaveProperty('boletoUrl');
  });

  it('provisioning: o passo atual e a estimativa; o certificado sem estimativa; passo estranho não sai', () => {
    expect(
      buildStatusView(
        tenant('provisioning', { provisioning: { attempts: 0, step: 'node.wait_ready' } }),
        DOMAINS,
      ),
    ).toMatchObject({ step: 'node.wait_ready', etaMinutes: 15, panelUrl: null });
    expect(buildStatusView(tenant('provisioning'), DOMAINS)).toMatchObject({
      step: 'preflight',
      etaMinutes: 30,
    });
    expect(
      buildStatusView(
        tenant('provisioning', { provisioning: { attempts: 0, step: 'panel.domain_wait' } }),
        DOMAINS,
      ),
    ).toMatchObject({ step: 'panel.domain_wait', etaMinutes: null });
    expect(
      buildStatusView(tenant('provisioning', { provisioning: { attempts: 0, step: 'interno.x' } }), DOMAINS),
    ).toMatchObject({ step: null, etaMinutes: null });
  });

  it('provisioning_failed: nem o passo nem o erro', () => {
    const view = buildStatusView(
      tenant('provisioning_failed', {
        provisioning: {
          attempts: 8,
          step: 'node.wait_ready',
          lastError: { code: 'node_error:x', at: new Date() },
        },
      }),
      DOMAINS,
    );
    expect(view).toEqual({
      state: 'provisioning_failed',
      step: null,
      etaMinutes: null,
      panelUrl: null,
      apiUrl: null,
      revealAvailable: false,
    });
    expect(JSON.stringify(view)).not.toContain('node_error');
  });

  it('espera da conexão: endereços e o botão até a senha ser mostrada', () => {
    expect(buildStatusView(tenant('waiting_customer_connection'), DOMAINS)).toMatchObject({
      panelUrl: PANEL,
      apiUrl: API,
      revealAvailable: true,
    });
    expect(
      buildStatusView(
        tenant('waiting_customer_connection', { access: { passwordRevealedAt: new Date() } }),
        DOMAINS,
      ),
    ).toMatchObject({ revealAvailable: false, panelUrl: PANEL });
  });

  it.each(['active', 'past_due', 'suspended', 'canceled'] as const)(
    '%s: endereços, sem revelação',
    (state) => {
      expect(buildStatusView(tenant(state), DOMAINS)).toEqual({
        state,
        step: null,
        etaMinutes: null,
        panelUrl: PANEL,
        apiUrl: API,
        revealAvailable: false,
      });
    },
  );
});
