import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { awsErrorCode, TemporaryCredentials } from '../../src/inventory/read-only-session.js';
import { awsError } from './fake-aws.js';

const SECRET = 'segredo-temporario-de-teste-0000000000';

describe('credenciais temporárias da sessão no papel de leitura', () => {
  it('servem aos clientes da AWS e guardam a validade', () => {
    const credentials = new TemporaryCredentials({
      accessKeyId: 'ASIAEXEMPLO000000000',
      secretAccessKey: SECRET,
      sessionToken: 'token-de-sessao-de-teste',
      expiration: new Date('2026-11-02T12:15:00.000Z'),
    });
    expect(credentials.identity()).toMatchObject({
      accessKeyId: 'ASIAEXEMPLO000000000',
      secretAccessKey: SECRET,
    });
    expect(credentials.expiration?.toISOString()).toBe('2026-11-02T12:15:00.000Z');
  });

  it('não viram JSON, texto nem saída de log', () => {
    const credentials = new TemporaryCredentials({
      accessKeyId: 'ASIAEXEMPLO000000000',
      secretAccessKey: SECRET,
      sessionToken: 'token-de-sessao-de-teste',
    });
    for (const rendered of [
      JSON.stringify({ credentials }),
      String(credentials),
      inspect(credentials),
      inspect({ nested: { credentials } }, { depth: 5 }),
    ]) {
      expect(rendered).not.toContain(SECRET);
      expect(rendered).not.toContain('token-de-sessao');
    }
    // Além do campo privado, o objeto se apresenta com um marcador explícito no log e no JSON.
    expect(inspect(credentials)).toBe('[credenciais temporárias]');
    expect(JSON.stringify({ credentials })).toBe('{"credentials":"[credenciais temporárias]"}');
  });

  it('o código do erro da AWS, nunca a mensagem', () => {
    expect(awsErrorCode(awsError('AccessDenied'))).toBe('AccessDenied');
    expect(awsErrorCode({ name: 'Nome com espaço e detalhe-interno' })).toBe('erro desconhecido');
    expect(awsErrorCode(null)).toBe('erro desconhecido');
  });
});
