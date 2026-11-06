import { describe, expect, it } from 'vitest';
import { demoConfiguration, demoLimits } from '../../test/support/pricing-fixtures.js';
import { loadConfig } from '../common/config/load-config.js';
import { NODE_LIMIT_RANGES } from './executor-env.js';
import { nodeFitProblems } from './node-fit.js';
import { accessEmailConfigured } from './provisioning-steps.js';

describe('nodeFitProblems (o que o envs/tenant sabe criar, a mesma regra do preflight e do console)', () => {
  it('o gerenciado, porte P, sem agentes e com os limites nas faixas cabe', () => {
    expect(nodeFitProblems(demoConfiguration(), demoLimits())).toEqual([]);
  });

  it('aponta cada motivo: outro modo, outro porte, agentes e limites fora das faixas', () => {
    expect(
      nodeFitProblems(
        { ...demoConfiguration(), mode: 'self_hosted', size: 'M', agents: 10 },
        {
          ...demoLimits(),
          maxAgents: 10,
          historyDays: NODE_LIMIT_RANGES.historyDays[0] - 1,
        },
      ),
    ).toEqual(['mode', 'size', 'agents', 'limits']);
    expect(
      nodeFitProblems(demoConfiguration(), {
        ...demoLimits(),
        maxCloudAccounts: NODE_LIMIT_RANGES.maxCloudAccounts[1] + 1,
      }),
    ).toEqual(['limits']);
  });
});

describe('accessEmailConfigured (o e-mail "ambiente pronto" do cliente de contrato direto)', () => {
  const base = { ROLE: 'worker', NODE_ENV: 'test' };
  const smtp = {
    SMTP_HOST: 'smtp.exemplo.example',
    SMTP_USER: 'nao-responda@verax.example',
    SMTP_PASSWORD: 'senha-smtp-de-teste',
    MAIL_FROM: 'nao-responda@verax.example',
  };
  const site = { SITE_SUCCESS_URL: 'https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}' };

  it('exige o SMTP do cp-worker e a página de status do site', () => {
    expect(accessEmailConfigured(loadConfig({ ...base, ...smtp, ...site }))).toBe(true);
    expect(accessEmailConfigured(loadConfig({ ...base, ...site }))).toBe(false);
    expect(accessEmailConfigured(loadConfig({ ...base, ...smtp }))).toBe(false);
  });
});
