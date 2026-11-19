import { Controller, Get, Header, Inject, Req } from '@nestjs/common';
import type { AuthClientConfig } from '@verax/shared';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { Public } from './decorators.js';
import { ssoSiteOf } from './sso/sso-site.js';

/**
 * O que o painel precisa saber antes de qualquer login: a chave do site do Turnstile (pública por natureza: vai no HTML
 * de quem usa o widget) e, só onde a equipe da Verax entra (o endereço dela na célula, ou o nó dedicado da Verax) com a
 * entrada única configurada, o endereço do console do responsável (`adminMasterUrl`: o botão "Entrar com o Admin
 * master" e o item "Admin master" do menu). Nada de segredo entra aqui. Sem sessão e com cache curto: o painel a lê a
 * cada tela de login, e trocar a chave no nó vale em poucos minutos. A resposta depende do endereço (`Host`), que já
 * faz parte da URL guardada em cache.
 *
 * Registrado antes do `AuthController`, cujo `*path` abrange `/auth/`: o Express casa as rotas na ordem em que
 * foram registradas.
 */
@Controller('auth/client-config')
@Public()
export class AuthClientConfigController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  read(@Req() request: Request): AuthClientConfig {
    const site = ssoSiteOf(this.config, request.hostTenant);
    return {
      turnstileSiteKey: this.config.TURNSTILE_SITE_KEY ?? null,
      adminMasterUrl: site === undefined ? null : `${site.sso.issuer}/`,
      nodePlatform: this.config.NODE_PLATFORM,
    };
  }
}
