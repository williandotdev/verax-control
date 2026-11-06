import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { forgetLiveSecret, scrubString } from '../common/logger/sanitize.js';
import {
  bootstrapSecretName,
  BootstrapUnavailableError,
  parseBootstrapPayload,
  type SecretManagerApi,
  SecretManagerBootstrapSecrets,
  versionStateName,
} from './bootstrap-secrets.js';

const PROJECT = 'projeto-dos-nos-demo';
const SECRET = bootstrapSecretName(PROJECT, 'cliente-demo-a');

function password(): string {
  return `Tmp-${randomBytes(15).toString('base64url')}`;
}

function payload(value: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: 'admin@cliente-demo-a.example',
    password: value,
    expiresAt: '2026-11-07T12:00:00.000Z',
    ...extra,
  });
}

class FakeApi implements SecretManagerApi {
  readonly destroyed: string[] = [];
  accessResult: Uint8Array | string | null | undefined = undefined;
  accessError: Error | undefined;
  listError: Error | undefined;
  destroyError: Error | undefined;
  versions: { name: string; state: string }[] = [];
  readonly accessed: string[] = [];

  accessLatest(name: string): Promise<Uint8Array | string | null | undefined> {
    this.accessed.push(name);
    return this.accessError === undefined
      ? Promise.resolve(this.accessResult)
      : Promise.reject(this.accessError);
  }

  listVersions(): Promise<{ name: string; state: string }[]> {
    return this.listError === undefined ? Promise.resolve(this.versions) : Promise.reject(this.listError);
  }

  destroyVersion(name: string): Promise<void> {
    if (this.destroyError !== undefined) return Promise.reject(this.destroyError);
    this.destroyed.push(name);
    return Promise.resolve();
  }
}

function grpcError(code: number): Error {
  return Object.assign(new Error(`erro ${code} em ${SECRET}`), { code });
}

describe('contrato do admin-bootstrap (CP-10)', () => {
  it('aceita exatamente email, password e expiresAt, e põe a senha na máscara do logger', () => {
    const value = password();
    const parsed = parseBootstrapPayload(Buffer.from(payload(value), 'utf8'));
    expect(parsed).toEqual({
      email: 'admin@cliente-demo-a.example',
      password: value,
      expiresAt: new Date('2026-11-07T12:00:00.000Z'),
    });
    expect(scrubString(`texto com ${value}`)).not.toContain(value);
    forgetLiveSecret(value);
  });

  it.each([
    ['JSON quebrado', '{"email": "abc'],
    ['campo a mais', payload(password(), { role: 'admin_verax' })],
    ['senha curta', payload('curta')],
    ['data sem fuso', payload(password(), { expiresAt: '2026-11-07T12:00:00' })],
    ['e-mail inválido', payload(password(), { email: 'nao-e-email' })],
  ])('recusa %s sem repetir o conteúdo no erro', (_case, text) => {
    let error: unknown;
    try {
      parseBootstrapPayload(text);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BootstrapUnavailableError);
    expect((error as BootstrapUnavailableError).reason).toBe('invalid_format');
    expect(JSON.stringify(error)).not.toContain('password');
    expect((error as Error).message).not.toContain('abc');
    expect((error as Error).cause).toBeUndefined();
  });
});

describe('SecretManagerBootstrapSecrets', () => {
  it('lê a versão latest do segredo do tenant no projeto dos nós', async () => {
    const api = new FakeApi();
    const value = password();
    api.accessResult = Buffer.from(payload(value), 'utf8');
    const secrets = new SecretManagerBootstrapSecrets(PROJECT, () => Promise.resolve(api));

    expect((await secrets.readLatest('cliente-demo-a')).password).toBe(value);
    expect(api.accessed).toEqual(['projects/projeto-dos-nos-demo/secrets/vx-cliente-demo-a-admin-bootstrap']);
    forgetLiveSecret(value);
  });

  it('segredo ou versão inexistente, destruída ou sem permissão vira indisponível; erro transitório passa', async () => {
    const api = new FakeApi();
    const secrets = new SecretManagerBootstrapSecrets(PROJECT, () => Promise.resolve(api));
    for (const [code, reason] of [
      [5, 'not_found'],
      [9, 'not_found'],
      [7, 'permission_denied'],
    ] as const) {
      api.accessError = grpcError(code);
      await expect(secrets.readLatest('cliente-demo-a')).rejects.toMatchObject({ reason });
    }
    api.accessError = undefined;
    api.accessResult = null;
    await expect(secrets.readLatest('cliente-demo-a')).rejects.toMatchObject({ reason: 'not_found' });
    api.accessError = grpcError(14);
    await expect(secrets.readLatest('cliente-demo-a')).rejects.toMatchObject({ code: 14 });
  });

  it('destrói toda versão viva, uma vez, e é idempotente', async () => {
    const api = new FakeApi();
    api.versions = [
      { name: `${SECRET}/versions/1`, state: 'DESTROYED' },
      { name: `${SECRET}/versions/2`, state: 'DISABLED' },
      { name: `${SECRET}/versions/3`, state: 'ENABLED' },
      { name: 'projects/outro/secrets/outro/versions/1', state: 'ENABLED' },
    ];
    const secrets = new SecretManagerBootstrapSecrets(PROJECT, () => Promise.resolve(api));

    expect(await secrets.destroyAll('cliente-demo-a')).toBe(2);
    expect(api.destroyed).toEqual([`${SECRET}/versions/2`, `${SECRET}/versions/3`]);

    api.destroyError = grpcError(9);
    expect(await secrets.destroyAll('cliente-demo-a')).toBe(0);
    api.listError = grpcError(5);
    expect(await secrets.destroyAll('cliente-demo-a')).toBe(0);
    api.listError = grpcError(14);
    await expect(secrets.destroyAll('cliente-demo-a')).rejects.toMatchObject({ code: 14 });
  });

  it('carrega o SDK uma vez e tenta de novo se a carga falhar', async () => {
    const api = new FakeApi();
    api.versions = [];
    let loads = 0;
    const secrets = new SecretManagerBootstrapSecrets(PROJECT, () => {
      loads += 1;
      return loads === 1 ? Promise.reject(new Error('sem rede')) : Promise.resolve(api);
    });
    await expect(secrets.destroyAll('cliente-demo-a')).rejects.toThrow('sem rede');
    expect(await secrets.destroyAll('cliente-demo-a')).toBe(0);
    expect(await secrets.destroyAll('cliente-demo-a')).toBe(0);
    expect(loads).toBe(2);
  });

  it('entende o estado da versão como texto ou como número do enum', () => {
    expect(versionStateName('DESTROYED')).toBe('DESTROYED');
    expect(versionStateName(3)).toBe('DESTROYED');
    expect(versionStateName(1)).toBe('ENABLED');
  });
});
