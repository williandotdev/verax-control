import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { isNodeServiceAccountId } from '@verax/shared';
import type { Clock } from '../common/clock.js';
import { ENROLLMENT_SECRET_PATTERN } from '../enrollment/enrollment.js';
import {
  decodeSegment,
  GOOGLE_ISSUERS,
  type IdentityFailure,
  type IdTokenKeySource,
  isBase64Url,
  MAX_CREDENTIAL_LENGTH,
  SIGNATURE_REMOVED,
  verifyGoogleSignature,
} from '../internal/identity-token.js';

/**
 * A credencial do nó dedicado na sincronização (`POST /v1/node-sync`), sempre no `Authorization: Bearer ...`:
 * - `gcp_identity`: no nó gerenciado (`NODE_PLATFORM=gcp`), o token de identidade do Google da conta de serviço do nó,
 *   pedido ao servidor de metadados com `audience=<NODE_SYNC_AUDIENCE>&format=full` (dura 1 h). O `sub` é o ID único
 *   da conta (`tenant.resources.serviceAccountUniqueId`) e o `format=full` acrescenta
 *   `google.compute_engine.{project_id, instance_name}`, conferidos com `resources.nodesProject` e `instanceName`;
 * - `node_key`: na VM do cliente (`NODE_PLATFORM=vm`), a chave do nó que o registro entregou (`enrollment/`, 32 bytes
 *   em base64url), guardada no cliente só como SHA-256.
 *
 * O cliente do plano de controle sai só daqui (nunca do corpo). Os dois valores entram na máscara do logger antes de
 * qualquer `await` e nunca vão a log, auditoria nem Firestore.
 */
export type NodeSyncCredential =
  { kind: 'gcp_identity'; token: string } | { kind: 'node_key'; nodeKey: string };

/** Um JWT assinado: três partes base64url não vazias, até 4 KB (a terceira não pode ser a assinatura removida). */
export function isSignedJwtShape(value: string): boolean {
  if (value.length > MAX_CREDENTIAL_LENGTH) return false;
  const parts = value.split('.');
  return parts.length === 3 && parts.every(isBase64Url) && parts[2] !== SIGNATURE_REMOVED;
}

/** A credencial do cabeçalho `Authorization: Bearer <JWT | nodeKey>`; fora do formato, `undefined`. */
export function nodeSyncCredentialFromAuthorization(
  header: string | string[] | undefined,
): NodeSyncCredential | undefined {
  if (typeof header !== 'string' || header.length > MAX_CREDENTIAL_LENGTH + 16) return undefined;
  const [scheme, value, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || rest.length > 0) return undefined;
  if (ENROLLMENT_SECRET_PATTERN.test(value)) return { kind: 'node_key', nodeKey: value };
  return isSignedJwtShape(value) ? { kind: 'gcp_identity', token: value } : undefined;
}

/** O ID único da conta de serviço do Google: 21 dígitos. */
const NODE_SA_SUB_PATTERN = /^\d{21}$/;

/** A vida máxima do token do servidor de metadados (1 h), com a folga de um minuto. */
const MAX_TOKEN_LIFETIME_SECONDS = 3600 + 60;

/** As declarações do token do nó com `format=full`; o resto (`email`, `azp`, zona, ids) é ignorado. */
const nodeIdentityClaimsSchema = z.object({
  iss: z.enum(GOOGLE_ISSUERS),
  aud: z.string().max(512),
  sub: z.string().regex(NODE_SA_SUB_PATTERN),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  google: z.object({
    compute_engine: z.object({
      project_id: z.string().min(1).max(64),
      instance_name: z.string().min(1).max(64),
    }),
  }),
});

/** O que a sincronização usa do token conferido. */
export interface NodeIdentity {
  /** O ID único da conta de serviço do nó (o `sub`). */
  serviceAccountId: string;
  /** O projeto da VM (`google.compute_engine.project_id`). */
  projectId: string;
  /** O nome da VM (`google.compute_engine.instance_name`). */
  instanceName: string;
}

export type NodeIdentityVerification =
  { ok: true; identity: NodeIdentity } | { ok: false; reason: IdentityFailure | 'audience' | 'lifetime' };

/**
 * Confere uma olhada barata, sem a assinatura, para o cp-public não acordar o cp-worker por qualquer coisa: o formato,
 * o `aud` igual ao da rota, o `sub` de 21 dígitos e o prazo pelo relógio injetável. Não autentica nada: quem confere a
 * assinatura é o cp-worker (`NodeIdentityVerifier`).
 */
export function plausibleNodeIdentity(token: string, audience: string, now: Date): boolean {
  if (!isSignedJwtShape(token)) return false;
  const payload = decodeSegment(token.split('.')[1] ?? '');
  if (payload === undefined) return false;
  return (
    payload['aud'] === audience &&
    typeof payload['sub'] === 'string' &&
    isNodeServiceAccountId(payload['sub']) &&
    typeof payload['exp'] === 'number' &&
    payload['exp'] * 1000 > now.getTime()
  );
}

/**
 * O verificador do token do nó gerenciado, no cp-worker. Diferente do `IdentityTokenVerifier` das rotas internas, a
 * identidade é o `sub` (a conta do nó não tem e-mail verificado útil aqui) e só um token **assinado** passa: o
 * `/v1/node-sync` chega pelo cp-public, nunca pela entrada autenticada do Cloud Run, então não existe assinatura
 * removida legítima. Confere com as chaves do Google (`IdTokenKeySource`, as mesmas das rotas internas, com a
 * releitura numa rotação de chave): RS256, emissor, `aud` exatamente `NODE_SYNC_AUDIENCE`, `iat` e `exp` (a biblioteca,
 * pelo relógio do sistema), a vida de no máximo 1 h, o `sub` de 21 dígitos e as declarações do `format=full`.
 */
export class NodeIdentityVerifier {
  private readonly client = new OAuth2Client();

  constructor(
    private readonly keySource: IdTokenKeySource,
    private readonly clock: Clock,
    private readonly audience: string,
  ) {}

  async verify(token: string): Promise<NodeIdentityVerification> {
    if (token.length > MAX_CREDENTIAL_LENGTH) return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(isBase64Url)) {
      return { ok: false, reason: parts[2] === '' ? 'signature_missing' : 'malformed' };
    }
    const [encodedHeader = '', encodedPayload = '', signature = ''] = parts;
    if (signature === SIGNATURE_REMOVED) return { ok: false, reason: 'signature_missing' };
    const jose = decodeSegment(encodedHeader);
    const payload = decodeSegment(encodedPayload);
    if (jose === undefined || payload === undefined) return { ok: false, reason: 'malformed' };
    const failure = await verifyGoogleSignature(this.client, this.keySource, token, jose, [this.audience]);
    if (failure !== undefined) return { ok: false, reason: failure };
    const parsed = nodeIdentityClaimsSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: 'claims' };
    const claims = parsed.data;
    // A biblioteca aceita a audiência numa lista; aqui ela tem de ser exatamente a da rota.
    if (claims.aud !== this.audience) return { ok: false, reason: 'audience' };
    if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) {
      return { ok: false, reason: 'lifetime' };
    }
    // O prazo de novo, pelo relógio injetável (a biblioteca usa o do sistema): os dois têm de aceitar.
    if (claims.exp * 1000 <= this.clock.now().getTime()) return { ok: false, reason: 'claims' };
    return {
      ok: true,
      identity: {
        serviceAccountId: claims.sub,
        projectId: claims.google.compute_engine.project_id,
        instanceName: claims.google.compute_engine.instance_name,
      },
    };
  }
}
