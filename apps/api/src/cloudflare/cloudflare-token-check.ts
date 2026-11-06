import { cloudflareAccountIdSchema } from '@verax/shared';
import { z } from 'zod';
import {
  type CheckedCredential,
  CredentialRejected,
  CredentialSourceUnavailable,
} from '../credentials/credential-check.js';
import type { CloudflareToken } from '../credentials/credential-vault.js';

/** O host oficial da API do Cloudflare: o único fora dos testes (sem variável de ambiente que o troque). */
export const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
/** Orçamento da conferência inteira (verify e leitura da auditoria), dentro da requisição de quem colou. */
export const CLOUDFLARE_CHECK_TIMEOUT_MS = 5_000;
/** Janela da leitura de prova da auditoria: basta a resposta, com no máximo uma entrada. */
const AUDIT_PROBE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Resposta do `tokens/verify` (de conta ou de usuário): o envelope do Cloudflare com `result.id` (até 32 caracteres),
 * `status` (`active`, `disabled` ou `expired`) e, quando definidos, `expires_on` e `not_before`. Só o que é usado.
 */
const verifyResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.string().regex(/^[A-Za-z0-9]{4,64}$/),
    status: z.enum(['active', 'disabled', 'expired']),
    expires_on: z.iso.datetime({ offset: true }).nullable().optional(),
    not_before: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
});
type VerifiedToken = z.infer<typeof verifyResponseSchema>['result'];

const auditProbeResponseSchema = z.object({ success: z.literal(true) });

/** Só o host oficial ou, nos testes, um servidor falso em 127.0.0.1 por http. */
export function isAllowedBaseUrl(baseUrl: string): boolean {
  if (baseUrl === CLOUDFLARE_API_BASE_URL) return true;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** De quem é o token: da conta (o recomendado) ou de um usuário. Cada um tem o seu verify. */
type VerifyOwner = 'account' | 'user';

function verifyPath(owner: VerifyOwner, accountId: string): string {
  return owner === 'account' ? `/accounts/${accountId}/tokens/verify` : '/user/tokens/verify';
}

/** RFC 3339 em segundos, como os exemplos da API de auditoria. */
export function rfc3339(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export interface CloudflareTokenCheckOptions {
  /** Só para os testes (servidor falso em 127.0.0.1); fora deles, o host oficial. */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Conferência do token colado (fase 2, PR-11'), na memória da API, antes de cifrar:
 *
 * 1. `GET /accounts/<conta>/tokens/verify` (token de conta, o recomendado) ou `GET /user/tokens/verify` (token de
 *    usuário). O prefixo do formato novo (`cfat_` ou `cfut_`) escolhe o endpoint; no formato antigo, sem prefixo,
 *    tenta o de conta e, recusado, o de usuário. O token precisa estar `active`, dentro da validade e já valendo;
 * 2. a leitura de prova da auditoria da conta cadastrada (`GET /accounts/<conta>/logs/audit`, uma entrada da última
 *    hora), que exige a permissão Account Settings: Read nessa conta. O `verify` sozinho não diz a quais contas o token
 *    dá acesso, e ler as próprias permissões pediria outra permissão (API Tokens Read).
 *
 * O filtro de IP do token não vale para o `verify` (documentação do Cloudflare), mas vale para a leitura de prova:
 * um token restrito a outro IP é recusado aqui, como seria na coleta.
 *
 * Tudo dentro de 5 s. O token só vai no header `Authorization`; nada da resposta vai para o log, só códigos.
 */
export class CloudflareTokenCheck {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor({
    baseUrl = CLOUDFLARE_API_BASE_URL,
    timeoutMs = CLOUDFLARE_CHECK_TIMEOUT_MS,
  }: CloudflareTokenCheckOptions = {}) {
    if (!isAllowedBaseUrl(baseUrl)) {
      throw new Error(
        'a API do Cloudflare só é chamada no host oficial (ou num servidor falso local, nos testes)',
      );
    }
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
  }

  async check(token: CloudflareToken, accountId: string, now: Date = new Date()): Promise<CheckedCredential> {
    // O ID vem do cadastro, já validado; conferido de novo porque entra no caminho da URL.
    if (!cloudflareAccountIdSchema.safeParse(accountId).success) throw new CredentialRejected('invalid');
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const verified = await this.verify(token, accountId, signal);
    if (verified.status === 'disabled') throw new CredentialRejected('inactive');
    if (verified.status === 'expired') throw new CredentialRejected('expired');
    const expiresAt = verified.expires_on ? new Date(verified.expires_on) : null;
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) throw new CredentialRejected('expired');
    if (verified.not_before && new Date(verified.not_before).getTime() > now.getTime()) {
      throw new CredentialRejected('not_yet_valid');
    }
    await this.probeAuditLog(token, accountId, now, signal);
    return { keyIdSuffix: verified.id.slice(-4), issuedAt: null, expiresAt };
  }

  private async verify(
    token: CloudflareToken,
    accountId: string,
    signal: AbortSignal,
  ): Promise<VerifiedToken> {
    const value = token.value();
    const owners: VerifyOwner[] = value.startsWith('cfut_')
      ? ['user']
      : value.startsWith('cfat_')
        ? ['account']
        : ['account', 'user'];
    let lastStatus: number | undefined;
    for (const owner of owners) {
      const path = verifyPath(owner, accountId);
      const { status, body } = await this.get(path, token, signal);
      if (status === 200) {
        const parsed = verifyResponseSchema.safeParse(body);
        if (!parsed.success) throw new CredentialSourceUnavailable('bad_response');
        return parsed.data.result;
      }
      lastStatus = status;
    }
    throw new CredentialRejected('invalid', lastStatus);
  }

  private async probeAuditLog(
    token: CloudflareToken,
    accountId: string,
    now: Date,
    signal: AbortSignal,
  ): Promise<void> {
    const query = new URLSearchParams({
      since: rfc3339(new Date(now.getTime() - AUDIT_PROBE_WINDOW_MS)),
      before: rfc3339(now),
      limit: '1',
    });
    const { status, body } = await this.get(
      `/accounts/${accountId}/logs/audit?${query.toString()}`,
      token,
      signal,
    );
    if (status !== 200) throw new CredentialRejected('no_account_access', status);
    if (!auditProbeResponseSchema.safeParse(body).success)
      throw new CredentialSourceUnavailable('bad_response');
  }

  /**
   * GET com o Bearer, sem seguir redirecionamento. 5xx e 429 são indisponibilidade da origem; os demais status voltam
   * para quem chamou decidir. O corpo de uma resposta 4xx não é lido além do necessário e nunca vai para o log.
   */
  private async get(
    path: string,
    token: CloudflareToken,
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        headers: { authorization: `Bearer ${token.value()}`, accept: 'application/json' },
        redirect: 'error',
        signal,
      });
    } catch {
      throw new CredentialSourceUnavailable(signal.aborted ? 'timeout' : 'network');
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new CredentialSourceUnavailable(`http_${response.status}`);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: null };
    }
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      throw new CredentialSourceUnavailable(signal.aborted ? 'timeout' : 'bad_response');
    }
  }
}
