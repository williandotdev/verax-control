import { X509Certificate } from 'node:crypto';
import { WAZUH_AGENTS_DEFAULT_MAX, WAZUH_AGENTS_MAX_LIMIT } from '@verax/shared';
import { z } from 'zod';

/**
 * Agentes do Wazuh nas instâncias do cliente, como a API os recebe do `start.sh` (WAZUH_AGENTS=true no node.conf;
 * desligado por padrão). A API não fala com o manager: ela só monta as instruções de instalação com o que o nó diz (o
 * IP fixo dos agentes, as faixas liberadas no firewall, a CA do certificado do registro e a senha de registro) e lê a
 * lista dos agentes que o worker grava no banco.
 */
export interface WazuhAgentsConfig {
  /** IP fixo de entrada dos agentes (a regra de encaminhamento do Terraform do nó). */
  address: string;
  /** Cliente do nó: os agentes registrados são dele, e só ele vê as instruções. */
  tenantId: string;
  /** Faixas de IP de saída do cliente liberadas no firewall; vazia, a liberação está pendente. */
  sources: string[];
  maxAgents: number;
  /** CA do certificado do registro, em PEM (pública). */
  caCertificate: string;
  /** Senha de registro do nó: só na resposta das instruções, para quem administra. */
  enrollmentPassword: string;
}

/** Faixas de /16 a /32, como o Terraform do nó e o install.sh aceitam. */
const sourcesSchema = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()))
  .pipe(
    z
      .array(
        z.cidrv4({ error: 'faixa IPv4 inválida' }).refine((cidr) => Number(cidr.split('/')[1]) >= 16, {
          error: 'faixa larga demais (use de /16 a /32)',
        }),
      )
      .max(20, { error: 'no máximo 20 faixas' }),
  );

/** As variáveis dos agentes na API. Todas opcionais: sem WAZUH_AGENTS=true, nenhuma é aceita. */
export const apiAgentsEnvShape = {
  WAZUH_AGENTS: z
    .enum(['true', 'false'], { error: 'deve ser true ou false' })
    .default('false')
    .transform((value) => value === 'true'),
  WAZUH_AGENTS_ADDRESS: z.ipv4({ error: 'deve ser um IPv4, sem máscara' }).optional(),
  WAZUH_AGENTS_TENANT: z.uuid({ error: 'deve ser o id do cliente do nó' }).optional(),
  WAZUH_AGENTS_SOURCES: sourcesSchema.optional(),
  WAZUH_AGENTS_MAX: z.coerce
    .number({ error: `deve ser um inteiro de 1 a ${WAZUH_AGENTS_MAX_LIMIT}` })
    .int({ error: `deve ser um inteiro de 1 a ${WAZUH_AGENTS_MAX_LIMIT}` })
    .min(1, { error: `deve ser um inteiro de 1 a ${WAZUH_AGENTS_MAX_LIMIT}` })
    .max(WAZUH_AGENTS_MAX_LIMIT, { error: `deve ser um inteiro de 1 a ${WAZUH_AGENTS_MAX_LIMIT}` })
    .optional(),
  WAZUH_AGENTS_CA: z.string().optional(),
  WAZUH_AGENTS_ENROLLMENT_PASSWORD: z
    .string()
    .regex(/^[A-Za-z0-9]{32,64}$/, { error: 'deve ter de 32 a 64 letras e dígitos' })
    .optional(),
};

type ApiAgentsEnv = {
  [K in keyof typeof apiAgentsEnvShape]: z.output<(typeof apiAgentsEnvShape)[K]>;
};

const REQUIRED_WHEN_ON = [
  'WAZUH_AGENTS_ADDRESS',
  'WAZUH_AGENTS_TENANT',
  'WAZUH_AGENTS_CA',
  'WAZUH_AGENTS_ENROLLMENT_PASSWORD',
] as const;
const ONLY_WHEN_ON = [...REQUIRED_WHEN_ON, 'WAZUH_AGENTS_SOURCES', 'WAZUH_AGENTS_MAX'] as const;

/** A CA do registro chega em base64 (o PEM tem quebras de linha): tem de ser um certificado de CA legível. */
function caCertificateOf(base64: string): string | null {
  try {
    const pem = Buffer.from(base64, 'base64').toString('utf8');
    if (!pem.trimStart().startsWith('-----BEGIN CERTIFICATE-----')) return null;
    const certificate = new X509Certificate(pem);
    return certificate.ca ? certificate.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Confere a combinação e devolve a configuração pronta (ou null, desligado). Ligado, o endereço, o cliente, a CA e a
 * senha são obrigatórios; desligado, nenhuma outra variável dos agentes é aceita (o start.sh não as escreve). As
 * mensagens citam só o nome da variável.
 */
export function wazuhAgentsConfigOf(env: ApiAgentsEnv, ctx: z.RefinementCtx): WazuhAgentsConfig | null {
  if (!env.WAZUH_AGENTS) {
    for (const key of ONLY_WHEN_ON) {
      if (env[key] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'só com WAZUH_AGENTS=true' });
      }
    }
    return null;
  }
  let complete = true;
  for (const key of REQUIRED_WHEN_ON) {
    if (env[key] === undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com WAZUH_AGENTS=true' });
      complete = false;
    }
  }
  const caCertificate = env.WAZUH_AGENTS_CA === undefined ? null : caCertificateOf(env.WAZUH_AGENTS_CA);
  if (env.WAZUH_AGENTS_CA !== undefined && caCertificate === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['WAZUH_AGENTS_CA'],
      message: 'deve ser o certificado da CA do registro, em PEM, codificado em base64',
    });
    complete = false;
  }
  if (!complete || caCertificate === null) return null;
  return {
    address: env.WAZUH_AGENTS_ADDRESS as string,
    tenantId: env.WAZUH_AGENTS_TENANT as string,
    sources: env.WAZUH_AGENTS_SOURCES ?? [],
    maxAgents: env.WAZUH_AGENTS_MAX ?? WAZUH_AGENTS_DEFAULT_MAX,
    caCertificate,
    enrollmentPassword: env.WAZUH_AGENTS_ENROLLMENT_PASSWORD as string,
  };
}

/**
 * O que o worker recebe: o arquivo da lista dos agentes (a pasta de /run/verax montada só leitura) e o cliente do nó,
 * sempre juntos. Sem os dois, a tarefa dos agentes não existe.
 */
export const workerAgentsEnvShape = {
  WAZUH_AGENTS_FILE: z
    .string()
    .regex(/^\/[\w./-]+$/, { error: 'deve ser o caminho absoluto do arquivo da lista' })
    .optional(),
  WAZUH_AGENTS_TENANT: z.uuid({ error: 'deve ser o id do cliente do nó' }).optional(),
};

export interface WazuhAgentsFeed {
  file: string;
  tenantId: string;
}

export function wazuhAgentsFeedOf(env: {
  WAZUH_AGENTS_FILE?: string | undefined;
  WAZUH_AGENTS_TENANT?: string | undefined;
}): WazuhAgentsFeed | null {
  if (env.WAZUH_AGENTS_FILE === undefined || env.WAZUH_AGENTS_TENANT === undefined) return null;
  return { file: env.WAZUH_AGENTS_FILE, tenantId: env.WAZUH_AGENTS_TENANT };
}
