import { describe, expect, it, vi } from 'vitest';

const fetchIdToken = vi.fn<(audience: string) => Promise<string>>();

vi.mock('google-auth-library', async (importOriginal) => {
  const original = await importOriginal<typeof import('google-auth-library')>();
  class FakeGoogleAuth {
    getIdTokenClient(audience: string): Promise<InstanceType<typeof original.IdTokenClient>> {
      return Promise.resolve(
        new original.IdTokenClient({ targetAudience: audience, idTokenProvider: { fetchIdToken } }),
      );
    }
  }
  return { ...original, GoogleAuth: FakeGoogleAuth };
});

const { GoogleAuthIdTokenSource } = await import('./google-id-token.js');

function jwt(exp: number): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ exp })}.assinatura`;
}

describe('GoogleAuthIdTokenSource (o token da conta do cp-admin para chamar o cp-worker)', () => {
  it('pede o token com a audiência pedida e guarda até perto do vencimento', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    fetchIdToken.mockResolvedValue(token);
    const source = new GoogleAuthIdTokenSource();
    const audience = 'https://cp-worker-111111111111.southamerica-east1.run.app';
    expect(await source.get(audience)).toBe(token);
    expect(await source.get(audience)).toBe(token);
    expect(fetchIdToken).toHaveBeenCalledTimes(1);
    expect(fetchIdToken).toHaveBeenCalledWith(audience);
  });

  it('falha da biblioteca vira um erro sem a mensagem dela', async () => {
    fetchIdToken.mockRejectedValue(new Error('arquivo /segredo/credencial.json não encontrado'));
    const source = new GoogleAuthIdTokenSource();
    await expect(source.get('https://cp-worker-1.southamerica-east1.run.app')).rejects.toThrow(
      'token de identidade indisponível',
    );
  });
});
