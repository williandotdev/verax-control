import { cloudflareOauthConfigSchema } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { TENANT_STATES } from '../tenants/tenant.schema.js';
import {
  type CloudflareOauthEnv,
  cloudflareOauthSettings,
  isSlugReleased,
  isTenantReleased,
} from './cloudflare-oauth-settings.js';

const AUDIENCE = 'https://conta.exemplo.com.br/v1/node-sync';
const ON: CloudflareOauthEnv = {
  CLOUDFLARE_OAUTH_CLIENT_ID: 'appdetestedemo01',
  CLOUDFLARE_OAUTH_SCOPES: ['zone.read', 'offline_access'],
  CLOUDFLARE_OAUTH_TENANT_SLUGS: ['cliente-demo-a'],
  NODE_SYNC_AUDIENCE: AUDIENCE,
};

function settingsOf(slugs: string[] | undefined) {
  const settings = cloudflareOauthSettings({ ...ON, CLOUDFLARE_OAUTH_TENANT_SLUGS: slugs });
  if (settings === null) throw new Error('deveria estar ligada');
  return settings;
}

describe('configuração da conexão do Cloudflare por OAuth', () => {
  it('desligada sem o app; ligada, a configuração é a do contrato, com o retorno na origem do cp-public', () => {
    expect(cloudflareOauthSettings({ ...ON, CLOUDFLARE_OAUTH_CLIENT_ID: undefined })).toBeNull();
    expect(cloudflareOauthSettings({ ...ON, CLOUDFLARE_OAUTH_SCOPES: undefined })).toBeNull();
    const { config } = settingsOf(['cliente-demo-a']);
    expect(cloudflareOauthConfigSchema.parse(config)).toEqual({
      clientId: 'appdetestedemo01',
      redirectUri: 'https://conta.exemplo.com.br/v1/public/cloudflare/callback',
      scopes: ['zone.read', 'offline_access'],
    });
  });

  it('a lista de clientes: ausente ou vazia, ninguém; * é todos', () => {
    for (const none of [undefined, []]) {
      expect(isSlugReleased(settingsOf(none), 'cliente-demo-a')).toBe(false);
    }
    expect(isSlugReleased(settingsOf(['cliente-demo-a']), 'cliente-demo-a')).toBe(true);
    expect(isSlugReleased(settingsOf(['cliente-demo-a']), 'cliente-demo-b')).toBe(false);
    expect(isSlugReleased(settingsOf(['*']), 'cliente-demo-b')).toBe(true);
  });

  it('só o servidor dedicado gerenciado, com a VM no ar', () => {
    const settings = settingsOf(['*']);
    const base = { slug: 'cliente-demo-a', hosting: undefined, placement: undefined } as const;
    const released = TENANT_STATES.filter((state) => isTenantReleased(settings, { ...base, state }));
    expect(released).toEqual(['provisioning', 'waiting_customer_connection', 'active', 'past_due']);
    expect(isTenantReleased(settings, { ...base, state: 'active', hosting: 'verax' })).toBe(true);
    expect(isTenantReleased(settings, { ...base, state: 'active', hosting: 'customer' })).toBe(false);
    const placement = {} as NonNullable<Parameters<typeof isTenantReleased>[1]['placement']>;
    expect(isTenantReleased(settings, { ...base, state: 'active', placement })).toBe(false);
    expect(isTenantReleased(settingsOf([]), { ...base, state: 'active' })).toBe(false);
  });
});
