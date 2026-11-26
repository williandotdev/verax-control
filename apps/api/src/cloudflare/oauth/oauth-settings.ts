import { Inject, Injectable } from '@nestjs/common';
import {
  cloudflareConnectMode,
  type CloudflareOauthConfig,
  cloudflareOauthConfigSchema,
  tenantSlugSchema,
} from '@verax/shared';
import { APP_CONFIG, type AppConfig } from '../../common/config/config.module.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';

/** A linha da sincronização com o plano de controle (uma por nó), onde o worker guarda a configuração. */
const SYNC_ROW_ID = 'node';

type SettingsConfig = Pick<
  AppConfig,
  'NODE_PLATFORM' | 'PLAN' | 'cell' | 'credentialsPublicKey' | 'API_ORIGIN'
>;

/** O "Conectar com Cloudflare" ligado neste nó: o app (sem segredo) e o subdomínio que vai no `state`. */
export interface CloudflareOauthNode {
  config: CloudflareOauthConfig;
  slug: string;
}

/** O subdomínio do cliente no endereço da API (`https://api-<slug>.<domínio>`), ou null fora desse formato. */
export function slugOfApiOrigin(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const [label = '', ...domain] = url.hostname.split('.');
  if (url.protocol !== 'https:' || url.port !== '' || domain.length < 2 || !label.startsWith('api-')) {
    return null;
  }
  const slug = label.slice('api-'.length);
  return tenantSlugSchema.safeParse(slug).success ? slug : null;
}

/**
 * O "Conectar com Cloudflare" neste nó, para a API. Existe só no nó dedicado gerenciado de cliente (nunca na célula, no nó
 * da própria Verax, `PLAN=interno`, nem na VM do cliente), com o cofre ligado e o endereço de que o `state` sai, e só com a
 * configuração que o plano de controle mandou (`ControlPlaneSync.cloudflareOauth`, gravada pelo worker e conferida de novo
 * aqui). Em qualquer outro caso, null: as rotas respondem 404, e vale o token colado.
 *
 * Lida do banco a cada uso: desligar no plano de controle vale na sincronização seguinte, sem reiniciar a API.
 */
@Injectable()
export class CloudflareOauthSettings {
  private readonly slug: string | null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) config: SettingsConfig,
  ) {
    const eligible =
      config.NODE_PLATFORM === 'gcp' &&
      config.PLAN !== 'interno' &&
      config.cell === null &&
      config.credentialsPublicKey !== null;
    this.slug = eligible ? slugOfApiOrigin(config.API_ORIGIN) : null;
  }

  async current(): Promise<CloudflareOauthNode | null> {
    const { slug } = this;
    if (slug === null) return null;
    const config = await this.stored();
    // O nó gerenciado já foi conferido; a regra do modo fica num lugar só (`packages/shared`).
    if (config === null || cloudflareConnectMode({ platform: 'gcp', oauth: config }) !== 'oauth') return null;
    return { config, slug };
  }

  /** A configuração guardada, se ainda vale pelo contrato. */
  protected async stored(): Promise<CloudflareOauthConfig | null> {
    const row = await this.prisma.controlPlaneSync.findUnique({
      where: { id: SYNC_ROW_ID },
      select: { cloudflareOauth: true },
    });
    const parsed = cloudflareOauthConfigSchema.safeParse(row?.cloudflareOauth ?? null);
    return parsed.success ? parsed.data : null;
  }
}
