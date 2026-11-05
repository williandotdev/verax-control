import { describe, expect, it } from 'vitest';
import { applicationResult, wantedCollectionError } from './wazuh-config.js';

const CURRENT = 'c'.repeat(64);
const OLD = 'a'.repeat(64);
const AT = '2026-11-04T12:00:00Z';

describe("resultado da aplicação no host (tarefa wazuh-config, PR-V4')", () => {
  it('o sinal da lista de agora diz ok ou error', () => {
    expect(applicationResult({ generation: CURRENT, status: 'ok', at: AT }, CURRENT)).toBe('ok');
    expect(applicationResult({ generation: CURRENT, status: 'error', at: AT }, CURRENT)).toBe('error');
  });

  it('error sem geração (o host nem leu a lista) vale para a lista de agora, qualquer que seja ela', () => {
    for (const generation of [CURRENT, OLD]) {
      expect(applicationResult({ generation: null, status: 'error', at: AT }, generation)).toBe('error');
    }
  });

  it('o resultado de uma lista antiga, ou nenhum sinal, é pending', () => {
    expect(applicationResult({ generation: OLD, status: 'ok', at: AT }, CURRENT)).toBe('pending');
    expect(applicationResult({ generation: OLD, status: 'error', at: AT }, CURRENT)).toBe('pending');
    expect(applicationResult(null, CURRENT)).toBe('pending');
  });
});

describe("aviso da coleta do nó nas contas AWS (tarefa wazuh-config, PR-V4')", () => {
  it('o token parado e a aplicação com erro viram o aviso; o do token vale mais (o estado já vem nessa ordem)', () => {
    for (const current of [null, 'aws_token_stale', 'wazuh_apply_failed']) {
      expect(wantedCollectionError('aws_token_stale', current)).toBe('aws_token_stale');
      expect(wantedCollectionError('wazuh_apply_failed', current)).toBe('wazuh_apply_failed');
    }
  });

  it('tudo certo, sem aviso; aguardando a lista de agora, só o aviso de aplicação de antes fica', () => {
    for (const current of [null, 'aws_token_stale', 'wazuh_apply_failed']) {
      expect(wantedCollectionError('ok', current)).toBeNull();
    }
    expect(wantedCollectionError('pending', 'wazuh_apply_failed')).toBe('wazuh_apply_failed');
    expect(wantedCollectionError('pending', 'aws_token_stale')).toBeNull();
    expect(wantedCollectionError('pending', null)).toBeNull();
  });
});
