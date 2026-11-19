import { z } from 'zod';
import { NODE_PLATFORMS } from './cloud-credentials.js';
import { PERMISSIONS, type Permission, ROLES } from './permissions.js';

const permissionNames = Object.keys(PERMISSIONS) as [Permission, ...Permission[]];

/** Resposta de `GET /v1/me`: a identidade da sessão, validada pelo painel antes de usar. */
export const meSchema = z.strictObject({
  userId: z.string().min(1),
  email: z.email(),
  role: z.enum(ROLES),
  /** Cliente ao qual o usuário pertence (null para admin_verax). */
  tenantId: z.uuid().nullable(),
  /** Cliente selecionado na sessão por um admin_verax. */
  activeTenantId: z.uuid().nullable(),
  /** Cliente cujos dados a sessão enxerga. */
  scopeTenantId: z.uuid().nullable(),
  mfaEnabled: z.boolean(),
  /** Entrou com a senha temporária: precisa trocá-la antes de tudo (depois, o MFA). */
  mustChangePassword: z.boolean(),
  permissions: z.array(z.enum(permissionNames)),
});
export type Me = z.infer<typeof meSchema>;

export const switchTenantResponseSchema = z.strictObject({ activeTenantId: z.uuid() });

/** Resposta de `GET /v1/auth/client-config`: o que o painel precisa saber antes do login. Nada aqui é segredo. */
export const authClientConfigSchema = z.strictObject({
  /** Chave do site do Cloudflare Turnstile; `null` com o desafio desligado (os formulários funcionam sem ele). */
  turnstileSiteKey: z.string().min(1).nullable(),
  /**
   * Entrada única pelo console do responsável (o "Admin master"): o endereço do console, só onde a equipe da Verax
   * entra (o endereço dela na célula, ou o nó dedicado da Verax, com `PLAN=interno`) e com a entrada única configurada
   * no nó; `null` em todo outro lugar. Com ele, o login mostra "Entrar com o Admin master" e o menu do `admin_verax`
   * leva ao console.
   */
  adminMasterUrl: z.url({ protocol: /^https$/ }).nullable(),
  /**
   * Onde o nó roda (`NODE_PLATFORM`): na GCP, a AWS e a GCP são lidas sem chave (o papel de leitura e a identidade da
   * VM); na VM própria do cliente (`vm`), com a chave de leitura colada em Contas cloud. O painel escolhe as instruções
   * por ele; quem recusa o tipo de credencial que não vale no nó é a API.
   */
  nodePlatform: z.enum(NODE_PLATFORMS),
});
export type AuthClientConfig = z.infer<typeof authClientConfigSchema>;
