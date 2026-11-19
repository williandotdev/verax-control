import { z } from 'zod';
import type { CloudProvider } from './cloud-accounts.js';

/**
 * Credencial de leitura colada no painel e guardada cifrada no cofre do nó (fase 2; `docs/ARQUITETURA.md`, "Cofre de
 * credenciais"). A rota é `PUT /v1/cloud-accounts/:id/credential`, com o corpo discriminado por `kind`: o token do
 * Cloudflare (PR-11', em todo nó) e, só no nó na VM própria do cliente (`NODE_PLATFORM=vm`), a chave de acesso de um
 * usuário IAM só de leitura da AWS e a chave de uma conta de serviço só de leitura da GCP. No nó da GCP, a AWS e a GCP
 * são lidas sem chave (o papel de leitura, `aws-reader.ts`, e a identidade da VM): a API recusa os dois tipos lá.
 *
 * O segredo vai num sentido só: a API confere, cifra e grava. Nada dele volta (a resposta é a conta, com os metadados
 * em `keyStatus`), e nem a auditoria nem o log o recebem.
 */

/**
 * Onde o nó roda (`NODE_PLATFORM` do `node.conf`): na GCP (o gerenciado, com a identidade do Google da VM) ou na VM
 * própria do cliente (`vm`, sem identidade de nuvem nenhuma). O painel lê pelo `GET /v1/auth/client-config`.
 */
export const NODE_PLATFORMS = ['gcp', 'vm'] as const;
export type NodePlatform = (typeof NODE_PLATFORMS)[number];

/**
 * Tipos guardados no cofre (o enum `CloudCredentialKind` do banco). A chave de acesso da AWS (`aws_access_key`) saiu
 * no PR-V3' (a AWS é lida pelo papel sem chave) e voltou para a VM própria do cliente, que não tem identidade do
 * Google para entrar no papel.
 */
export const CLOUD_CREDENTIAL_KINDS = [
  'cloudflare_api_token',
  'aws_access_key',
  'gcp_service_account_key',
] as const;
export type CloudCredentialKind = (typeof CLOUD_CREDENTIAL_KINDS)[number];

/** Tipos que o painel aceita colar. Um tipo novo é mais um item aqui e mais uma opção em `cloudCredentialInputSchema`. */
export const ACCEPTED_CREDENTIAL_KINDS = [
  'cloudflare_api_token',
  'aws_access_key',
  'gcp_service_account_key',
] as const satisfies readonly CloudCredentialKind[];
export type AcceptedCredentialKind = (typeof ACCEPTED_CREDENTIAL_KINDS)[number];

/** Provedor de cada tipo: a credencial só vale numa conta do provedor dela. */
export const CREDENTIAL_KIND_PROVIDERS = {
  cloudflare_api_token: 'cloudflare',
  aws_access_key: 'aws',
  gcp_service_account_key: 'gcp',
} as const satisfies Record<CloudCredentialKind, CloudProvider>;

/**
 * Tipos que só o nó na VM própria do cliente aceita: lá não há identidade de nuvem, e a AWS e a GCP são lidas com a
 * chave de leitura colada no painel. No nó da GCP, os dois ficam de fora (a leitura é sem chave), e a API recusa.
 */
export const VM_ONLY_CREDENTIAL_KINDS = [
  'aws_access_key',
  'gcp_service_account_key',
] as const satisfies readonly AcceptedCredentialKind[];

/** O tipo vale no nó desta plataforma? O Cloudflare vale em todos; as chaves da AWS e da GCP, só na VM própria. */
export function credentialKindAllowed(kind: AcceptedCredentialKind, platform: NodePlatform): boolean {
  return platform === 'vm' || !(VM_ONLY_CREDENTIAL_KINDS as readonly string[]).includes(kind);
}

/** O tipo de credencial que o provedor recebe no nó desta plataforma (null: o provedor é lido sem chave). */
export function credentialKindFor(
  provider: CloudProvider,
  platform: NodePlatform,
): AcceptedCredentialKind | null {
  const kind = ACCEPTED_CREDENTIAL_KINDS.find(
    (candidate) => CREDENTIAL_KIND_PROVIDERS[candidate] === provider,
  );
  return kind !== undefined && credentialKindAllowed(kind, platform) ? kind : null;
}

/** Tamanho aceito do token: os antigos têm 40 caracteres; os novos, prefixo (`cfat_`, `cfut_`), 40 e o checksum. */
export const CLOUDFLARE_TOKEN_MIN_LENGTH = 40;
export const CLOUDFLARE_TOKEN_MAX_LENGTH = 255;

/** Símbolos do alfabeto do Bearer (RFC 6750) além de letras e números; o `=` de preenchimento não aparece em token. */
const BEARER_SYMBOLS = '-._~+/';

function isAsciiLetterOrDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isLowerHex(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
}

/**
 * A Global API Key dá acesso total à conta e nunca é aceita: no formato novo, começa com `cfk_`; no antigo, são de 37
 * a 45 caracteres hexadecimais minúsculos (o token antigo tem 40 caracteres de letras maiúsculas e minúsculas, números,
 * `-` e `_`). Conferido caractere a caractere, em tempo linear e sem expressão regular.
 */
export function isCloudflareGlobalApiKey(value: string): boolean {
  if (value.startsWith('cfk_')) return true;
  if (value.length < 37 || value.length > 45) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isLowerHex(value.charCodeAt(index))) return false;
  }
  return true;
}

/** Formato de um token de API do Cloudflare: o alfabeto do Bearer, com tamanho limitado, sem espaço nem quebra de linha. */
export function isCloudflareApiTokenShape(value: string): boolean {
  if (value.length < CLOUDFLARE_TOKEN_MIN_LENGTH || value.length > CLOUDFLARE_TOKEN_MAX_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiLetterOrDigit(code) && !BEARER_SYMBOLS.includes(value.charAt(index))) return false;
  }
  return true;
}

export const GLOBAL_KEY_REFUSED_MESSAGE =
  'Esta é a Global API Key, que dá acesso total à conta. Crie um token de API só de leitura.';
export const CLOUDFLARE_TOKEN_FORMAT_MESSAGE =
  'Token do Cloudflare inválido: cole o valor completo do token de API, sem espaços.';

/** O token colado. As mensagens nunca repetem o valor. */
export const cloudflareApiTokenSchema = z.string().superRefine((value, ctx) => {
  if (isCloudflareGlobalApiKey(value)) {
    ctx.addIssue({ code: 'custom', message: GLOBAL_KEY_REFUSED_MESSAGE });
    return;
  }
  if (!isCloudflareApiTokenShape(value))
    ctx.addIssue({ code: 'custom', message: CLOUDFLARE_TOKEN_FORMAT_MESSAGE });
});

/**
 * Chave de acesso de um usuário IAM (a VM própria do cliente). Só a chave de longo prazo de um usuário (`AKIA` e 16
 * caracteres do base32 da AWS): a temporária (`ASIA`, de uma sessão) vence em horas e pede o token da sessão. O segredo
 * tem 40 caracteres de base64. As mensagens nunca repetem o valor.
 */
export const AWS_ACCESS_KEY_ID_PATTERN = /^AKIA[A-Z2-7]{16}$/;
export const AWS_SECRET_ACCESS_KEY_PATTERN = /^[A-Za-z0-9/+]{40}$/;
export const AWS_KEY_ID_FORMAT_MESSAGE =
  'ID da chave de acesso inválido: cole o ID da chave do usuário IAM (20 caracteres, começa com AKIA).';
export const AWS_TEMPORARY_KEY_MESSAGE =
  'Esta é uma chave temporária (ASIA). Crie uma chave de acesso do usuário IAM de leitura (começa com AKIA).';
export const AWS_KEY_BODY_FORMAT_MESSAGE =
  'Chave secreta inválida: cole os 40 caracteres da chave secreta, sem espaços.';

const AWS_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const AWS_KEY_BODY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+';

/** Tamanho fixo e só caracteres do alfabeto (sem expressão regular sobre o que o usuário colou). */
function inAlphabet(value: string, alphabet: string): boolean {
  return [...value].every((char) => alphabet.includes(char));
}

/** O mesmo que `AWS_ACCESS_KEY_ID_PATTERN`, conferido sem regex. */
export function isAwsAccessKeyId(value: string): boolean {
  return value.length === 20 && value.startsWith('AKIA') && inAlphabet(value.slice(4), AWS_BASE32);
}

/** O mesmo que `AWS_SECRET_ACCESS_KEY_PATTERN`, conferido sem regex. */
export function isAwsKeyBody(value: string): boolean {
  return value.length === 40 && inAlphabet(value, AWS_KEY_BODY_ALPHABET);
}

export const awsAccessKeyIdSchema = z.string().superRefine((value, ctx) => {
  if (isAwsAccessKeyId(value)) return;
  ctx.addIssue({
    code: 'custom',
    message: value.startsWith('ASIA') ? AWS_TEMPORARY_KEY_MESSAGE : AWS_KEY_ID_FORMAT_MESSAGE,
  });
});
export const awsSecretAccessKeySchema = z.string().superRefine((value, ctx) => {
  if (!isAwsKeyBody(value)) ctx.addIssue({ code: 'custom', message: AWS_KEY_BODY_FORMAT_MESSAGE });
});

/**
 * Chave de uma conta de serviço da GCP (a VM própria do cliente). O painel lê o arquivo JSON que o Google entrega e
 * manda só os quatro campos que o nó usa (`gcpServiceAccountKeyFromJson`); o resto (`client_id`, `auth_uri`,
 * `token_uri` e os de certificado) nunca sai do navegador, e o nó nunca usa um endereço vindo da chave: o token é
 * pedido sempre ao `oauth2.googleapis.com`.
 * - `clientEmail`: conta de serviço criada pelo usuário (`<nome>@<projeto>.iam.gserviceaccount.com`); as dos agentes
 *   de serviço do Google e as de outros domínios são recusadas;
 * - `privateKeyId`: os 40 hexadecimais do ID da chave (os 4 últimos vão para `keyIdSuffix`);
 * - `privateKey`: o PEM PKCS#8 (`BEGIN PRIVATE KEY`) com linhas de base64 e tamanho limitado (a RSA-2048 que o
 *   Google gera tem cerca de 1.700 caracteres; o teto é 4.096).
 */
const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const GCP_SERVICE_ACCOUNT_EMAIL_PATTERN =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
export const GCP_PRIVATE_KEY_ID_PATTERN = /^[0-9a-f]{40}$/;
export const GCP_PRIVATE_KEY_MAX_LENGTH = 4096;
/** O arquivo JSON da chave (pouco mais de 2 KB numa RSA-2048): maior que isso, nem é lido. */
export const GCP_KEY_FILE_MAX_LENGTH = 8192;
export const GCP_KEY_FORMAT_MESSAGE =
  'Chave da conta de serviço inválida: cole o conteúdo inteiro do arquivo JSON que o Google baixou ao criar a chave.';
export const GCP_KEY_NOT_SERVICE_ACCOUNT_MESSAGE =
  'Este arquivo não é a chave de uma conta de serviço (o campo type precisa ser service_account).';
export const GCP_KEY_EMAIL_MESSAGE =
  'A chave precisa ser de uma conta de serviço criada num projeto seu (<nome>@<projeto>.iam.gserviceaccount.com).';

// Montados em partes: o cabeçalho literal no bundle do painel dispararia a varredura de segredos (scripts/scan-bundle.mjs),
// que procura chaves privadas coladas no código. Aqui é só o formato que se confere.
const PEM_LABEL = ['PRIVATE', 'KEY'].join(' ');
const PEM_HEADER = `-----BEGIN ${PEM_LABEL}-----`;
const PEM_FOOTER = `-----END ${PEM_LABEL}-----`;
const BASE64_LINE = /^[A-Za-z0-9+/]{1,76}={0,2}$/;

/**
 * O PEM PKCS#8 da chave: cabeçalho, de 10 a 80 linhas de base64 (até 76 caracteres cada) e o rodapé, com uma quebra de
 * linha no fim ou não. Conferido linha a linha, em tempo linear.
 */
export function isGcpPrivateKeyShape(value: string): boolean {
  if (value.length > GCP_PRIVATE_KEY_MAX_LENGTH) return false;
  const lines = (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
  if (lines.length < 12 || lines.length > 82) return false;
  if (lines[0] !== PEM_HEADER || lines[lines.length - 1] !== PEM_FOOTER) return false;
  return lines.slice(1, -1).every((line) => BASE64_LINE.test(line));
}

/** Os campos da chave da conta de serviço que o nó guarda. */
export const gcpServiceAccountKeyFieldsSchema = z.strictObject({
  projectId: z.string().regex(GCP_PROJECT_ID, { error: GCP_KEY_FORMAT_MESSAGE }),
  clientEmail: z
    .string()
    .max(128, { error: GCP_KEY_EMAIL_MESSAGE })
    .regex(GCP_SERVICE_ACCOUNT_EMAIL_PATTERN, { error: GCP_KEY_EMAIL_MESSAGE })
    // Os agentes de serviço do Google (`service-<número>@gcp-sa-<serviço>.iam...`) não são do cliente.
    .refine((email) => !email.includes('@gcp-sa-'), { error: GCP_KEY_EMAIL_MESSAGE }),
  privateKeyId: z.string().regex(GCP_PRIVATE_KEY_ID_PATTERN, { error: GCP_KEY_FORMAT_MESSAGE }),
  privateKey: z.string().refine(isGcpPrivateKeyShape, { error: GCP_KEY_FORMAT_MESSAGE }),
});
export type GcpServiceAccountKeyFields = z.infer<typeof gcpServiceAccountKeyFieldsSchema>;

/** O arquivo da chave como o Google o entrega: só os campos que interessam (os outros são ignorados). */
const gcpKeyFileSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string(),
  private_key_id: z.string(),
  private_key: z.string(),
  client_email: z.string(),
});

/**
 * Do texto do arquivo JSON da chave (o que o painel lê) aos campos que vão para a API. O erro é só a mensagem, sem
 * nada do conteúdo.
 */
export function gcpServiceAccountKeyFromJson(
  text: string,
): { ok: true; fields: GcpServiceAccountKeyFields } | { ok: false; message: string } {
  if (text.length > GCP_KEY_FILE_MAX_LENGTH) return { ok: false, message: GCP_KEY_FORMAT_MESSAGE };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: GCP_KEY_FORMAT_MESSAGE };
  }
  if (typeof json !== 'object' || json === null) return { ok: false, message: GCP_KEY_FORMAT_MESSAGE };
  if ((json as { type?: unknown }).type !== 'service_account') {
    return { ok: false, message: GCP_KEY_NOT_SERVICE_ACCOUNT_MESSAGE };
  }
  const file = gcpKeyFileSchema.safeParse(json);
  if (!file.success) return { ok: false, message: GCP_KEY_FORMAT_MESSAGE };
  const fields = gcpServiceAccountKeyFieldsSchema.safeParse({
    projectId: file.data.project_id,
    clientEmail: file.data.client_email,
    privateKeyId: file.data.private_key_id,
    privateKey: file.data.private_key,
  });
  if (!fields.success) {
    return { ok: false, message: fields.error.issues[0]?.message ?? GCP_KEY_FORMAT_MESSAGE };
  }
  return { ok: true, fields: fields.data };
}

/** Corpo do `PUT /v1/cloud-accounts/:id/credential`: uma opção por tipo aceito, estrita. */
export const cloudCredentialInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cloudflare_api_token'), token: cloudflareApiTokenSchema }),
  z.strictObject({
    kind: z.literal('aws_access_key'),
    accessKeyId: awsAccessKeyIdSchema,
    secretAccessKey: awsSecretAccessKeySchema,
  }),
  z.strictObject({
    kind: z.literal('gcp_service_account_key'),
    ...gcpServiceAccountKeyFieldsSchema.shape,
  }),
]);
export type CloudCredentialInput = z.infer<typeof cloudCredentialInputSchema>;

/** Dias antes do vencimento em que o painel avisa que o token precisa ser trocado. */
export const CREDENTIAL_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

/** Situação da credencial pela validade: em dia, vencendo (nos próximos 14 dias) ou vencida. */
export const CREDENTIAL_STATUSES = ['active', 'expiring', 'expired'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export function credentialStatus(expiresAt: Date | string | null, now: Date = new Date()): CredentialStatus {
  if (expiresAt === null) return 'active';
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (remaining <= 0) return 'expired';
  return remaining <= CREDENTIAL_EXPIRY_WARNING_DAYS * DAY_MS ? 'expiring' : 'active';
}

/** Dias inteiros até o vencimento, arredondados para cima (vence hoje à noite: 1); null sem validade. */
export function daysUntilExpiry(expiresAt: Date | string | null, now: Date = new Date()): number | null {
  if (expiresAt === null) return null;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS));
}

/**
 * Metadados da credencial guardada, o que a conta mostra (`CloudAccount.keyStatus`). Nunca o segredo, o texto cifrado
 * ou a versão da chave do nó.
 */
export const cloudCredentialStatusSchema = z.strictObject({
  kind: z.enum(CLOUD_CREDENTIAL_KINDS),
  /**
   * Os 4 últimos caracteres do ID da credencial na origem, nunca do segredo: o ID do token do Cloudflare, o da chave
   * de acesso da AWS ou o da chave da conta de serviço da GCP. O painel mostra `…abcd`.
   */
  keyIdSuffix: z.string().regex(/^[A-Za-z0-9]{4}$/),
  /** Criação da credencial na origem, quando ela informa (o `verify` do Cloudflare não informa). */
  issuedAt: z.iso.datetime().nullable(),
  /** Validade do token; null quando não vence. */
  expiresAt: z.iso.datetime().nullable(),
  /** Última conferência bem-sucedida na origem. */
  verifiedAt: z.iso.datetime(),
  /** Pela validade, na hora da resposta. */
  status: z.enum(CREDENTIAL_STATUSES),
});
export type CloudCredentialStatus = z.infer<typeof cloudCredentialStatusSchema>;

/**
 * Permissões do token de conta do Cloudflare, todas só de leitura (o nome é o do painel do Cloudflare, e `key` é a
 * chave do grupo de permissão no link de criação):
 * - Account Settings: Read: a auditoria da conta (audit logs v2);
 * - Zone: Read: a lista de zonas da conta;
 * - Analytics: Read (zona): os eventos de segurança do WAF pela API GraphQL.
 */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  { key: 'account_settings', type: 'read', scope: 'Conta', name: 'Account Settings' },
  { key: 'zone', type: 'read', scope: 'Zona', name: 'Zone' },
  { key: 'analytics', type: 'read', scope: 'Zona', name: 'Analytics' },
] as const;

/** Nome sugerido para o token no Cloudflare. */
export const CLOUDFLARE_TOKEN_NAME = 'Verax Control (somente leitura)';

/**
 * Link que abre a criação de um token de conta (account-owned) no painel do Cloudflare com as permissões de leitura já
 * marcadas. O `:account` faz o Cloudflare perguntar a conta. Formato documentado em
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/.
 */
export function cloudflareTokenTemplateUrl(): string {
  const keys = JSON.stringify(CLOUDFLARE_TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type })));
  return (
    'https://dash.cloudflare.com/?to=/:account/api-tokens' +
    `&permissionGroupKeys=${encodeURIComponent(keys)}&name=${encodeURIComponent(CLOUDFLARE_TOKEN_NAME)}`
  );
}
