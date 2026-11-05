import { describe, expect, it } from 'vitest';
import { nextConnection, wantedError } from './wazuh-config.js';

const connected = { connection: 'connected', connectionError: null } as const;
const waiting = { connection: 'waiting', connectionError: null } as const;
const failed = (code: string) => ({ connection: 'error', connectionError: code }) as const;

describe("estado da coleta do nó nas contas AWS (tarefa wazuh-config, PR-V4')", () => {
  it('o erro do nó: o do token vale mais; aguardando a lista de agora, o de aplicação de antes fica', () => {
    expect(wantedError('aws_token_stale', connected)).toBe('aws_token_stale');
    expect(wantedError('wazuh_apply_failed', connected)).toBe('wazuh_apply_failed');
    expect(wantedError('ok', failed('wazuh_apply_failed'))).toBeNull();
    expect(wantedError('pending', failed('wazuh_apply_failed'))).toBe('wazuh_apply_failed');
    expect(wantedError('pending', failed('aws_token_stale'))).toBeNull();
    expect(wantedError('pending', connected)).toBeNull();
  });

  it('só a conta conectada recebe o erro do nó, e só o erro do nó volta a "conectada"', () => {
    expect(nextConnection(connected, 'aws_token_stale')).toEqual({
      connection: 'error',
      connectionError: 'aws_token_stale',
    });
    expect(nextConnection(connected, null)).toBeNull();
    expect(nextConnection(failed('aws_token_stale'), null)).toEqual({
      connection: 'connected',
      connectionError: null,
    });
    expect(nextConnection(failed('aws_token_stale'), 'wazuh_apply_failed')).toEqual({
      connection: 'error',
      connectionError: 'wazuh_apply_failed',
    });
    expect(nextConnection(failed('wazuh_apply_failed'), 'wazuh_apply_failed')).toBeNull();
    // O erro da própria conta (o papel, um bucket) e a verificação pendente valem mais: ficam como estão.
    for (const current of [failed('bucket_denied'), failed('trust_denied'), waiting]) {
      expect(nextConnection(current, 'aws_token_stale')).toBeNull();
      expect(nextConnection(current, null)).toBeNull();
    }
  });
});
