import { describe, expect, it } from 'vitest';
import { wantedCollectionError } from './wazuh-config.js';

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
