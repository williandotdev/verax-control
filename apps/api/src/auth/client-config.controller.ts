import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { AuthClientConfig } from '@verax/shared';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { Public } from './decorators.js';

/**
 * O que o painel precisa saber antes de qualquer login: hoje, só a chave do site do Turnstile (pública por natureza:
 * vai no HTML de quem usa o widget). Nada de segredo entra aqui. Sem sessão e com cache curto: o painel a lê a cada
 * tela de login, e trocar a chave no nó vale em poucos minutos.
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
  read(): AuthClientConfig {
    return { turnstileSiteKey: this.config.TURNSTILE_SITE_KEY ?? null };
  }
}
