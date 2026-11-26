import { z } from 'zod';
import { bucketNameProblem, isAwsRegion } from './cloud-accounts.js';

/**
 * O log de acesso de um ALB ligado pelo painel (`/v1/web-logs/sources/:id/access-logs`). Só com a pilha do papel de leitura
 * com `EnableAlbAccessLogs=true`, que cria um bucket só para isso e deixa o papel mudar os atributos de um ALB da região.
 *
 * - O cliente pede no painel, balanceador a balanceador; o worker, que é quem fala com a AWS, lê os atributos de novo e só
 *   então liga. Se o log já está ligado, em qualquer bucket, nada muda.
 * - O nó só manda as três chaves do log de acesso (`ALB_ACCESS_LOG_KEYS`), com o bucket da pilha e sem prefixo. O IAM não
 *   filtra qual atributo muda: a trava é do código (`apps/api/src/weblogs/alb-logging/alb-access-logs.ts`).
 * - "Desligar" só vale para o que a Verax ligou (`enabledByVerax`), e só se o destino ainda for o que ela deixou.
 * - Rotas à parte da fonte (`GET /v1/web-logs/sources/:id`): um campo novo naquela resposta derrubaria a tela de um painel
 *   de antes. O nó de antes não tem estas rotas (404 sem código): o painel mostra o caminho de antes, o comando.
 */

/** As únicas chaves de atributo que o nó manda a um ALB. */
export const ALB_ACCESS_LOG_KEYS = {
  enabled: 'access_logs.s3.enabled',
  bucket: 'access_logs.s3.bucket',
  prefix: 'access_logs.s3.prefix',
} as const;

/** O prefixo do log que a Verax liga: nenhum (os arquivos ficam em `AWSLogs/<conta>/`, que a leitura já entende). */
export const ALB_ACCESS_LOG_PREFIX = '';

/** A etiqueta do papel com a região e o bucket da pilha (`<região>/<bucket>`), só com `EnableAlbAccessLogs`. */
export const AWS_READER_ALB_LOGS_TAG = 'verax-control:alb-logs-bucket';
/** O parâmetro da pilha que cria o bucket e dá a permissão. */
export const AWS_READER_ALB_LOGS_PARAMETER = 'EnableAlbAccessLogs';

/** O bucket da pilha para o log dos ALB, como a etiqueta do papel o diz. */
export interface AlbLogsBucket {
  region: string;
  bucket: string;
}

/**
 * Lê a etiqueta `verax-control:alb-logs-bucket` do papel (entrada externa: vem da conta do cliente). Só uma região da AWS e
 * um nome de bucket válido, separados por uma `/`; qualquer outra coisa é como se a etiqueta não existisse. A chave de uma
 * etiqueta de papel não distingue maiúsculas de minúsculas no IAM.
 */
export function parseAlbLogsBucketTag(
  tags: readonly { Key?: string | undefined; Value?: string | undefined }[] | null | undefined,
): AlbLogsBucket | null {
  const found = (tags ?? []).find(
    (tag) => typeof tag.Key === 'string' && tag.Key.toLowerCase() === AWS_READER_ALB_LOGS_TAG,
  );
  const value = found?.Value;
  if (typeof value !== 'string' || value.length > 128) return null;
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const [region = '', bucket = ''] = parts;
  if (!isAwsRegion(region) || bucketNameProblem(bucket) !== null) return null;
  return { region, bucket };
}

export const WEB_ALB_LOGGING_ACTIONS = ['enable', 'disable'] as const;
export type WebAlbLoggingAction = (typeof WEB_ALB_LOGGING_ACTIONS)[number];

/**
 * O último resultado:
 * - `enabled`: a Verax ligou o log no bucket da pilha;
 * - `already_enabled`: o log já estava ligado (em qualquer bucket); nada mudou;
 * - `disabled`: o log que a Verax ligou foi desligado (ou já estava desligado);
 * - `released`: alguém mudou o log fora do painel depois de a Verax ligar; nada mudou, e ele deixa de ser da Verax;
 * - `failed`: nada mudou, com o motivo (`WEB_ALB_LOGGING_FAILURES`).
 */
export const WEB_ALB_LOGGING_STATUSES = [
  'enabled',
  'already_enabled',
  'disabled',
  'released',
  'failed',
] as const;
export type WebAlbLoggingStatus = (typeof WEB_ALB_LOGGING_STATUSES)[number];

/**
 * Por que não mudou:
 * - `stack_update_required`: a pilha não tem `EnableAlbAccessLogs` (o papel não tem a etiqueta do bucket), ou a conta usa a
 *   chave de um usuário de leitura, que não liga nada;
 * - `permission_denied`: a AWS negou a mudança (a pilha antiga, ou uma política da organização);
 * - `other_region`: o bucket da pilha é de outra região (o ALB só grava num bucket da região dele);
 * - `bucket_rejected`: a AWS não conseguiu gravar no bucket (a política dele foi mudada, ou ele não existe mais);
 * - `balancer_missing`: o balanceador não existe mais, ou não é um ALB desta conta;
 * - `account_not_connected`: a conta não entra no papel agora;
 * - `throttled`: a AWS limitou as chamadas; pedir de novo mais tarde;
 * - `failed`: outro erro (o detalhe só no log interno).
 */
export const WEB_ALB_LOGGING_FAILURES = [
  'stack_update_required',
  'permission_denied',
  'other_region',
  'bucket_rejected',
  'balancer_missing',
  'account_not_connected',
  'throttled',
  'failed',
] as const;
export type WebAlbLoggingFailure = (typeof WEB_ALB_LOGGING_FAILURES)[number];

/** O pedido de ligar ou desligar: só a confirmação de quem viu o que muda. */
export const webAlbLoggingRequestSchema = z.strictObject({ confirm: z.literal(true) });
export type WebAlbLoggingRequest = z.infer<typeof webAlbLoggingRequestSchema>;

const bucketName = z.string().min(3).max(63);

/** `GET /v1/web-logs/sources/:id/access-logs` e a resposta dos pedidos (202). */
export const webAlbLoggingSchema = z.strictObject({
  sourceId: z.uuid(),
  /** Pedido e ainda não respondido pelo worker. */
  pending: z.enum(WEB_ALB_LOGGING_ACTIONS).nullable(),
  requestedAt: z.iso.datetime().nullable(),
  /** A ação do último resultado. */
  lastAction: z.enum(WEB_ALB_LOGGING_ACTIONS).nullable(),
  status: z.enum(WEB_ALB_LOGGING_STATUSES).nullable(),
  errorCode: z.enum(WEB_ALB_LOGGING_FAILURES).nullable(),
  completedAt: z.iso.datetime().nullable(),
  /** O log está ligado no bucket da pilha, como a Verax o deixou: só então o "Desligar" vale. */
  enabledByVerax: z.boolean(),
  /** O bucket em que o log está (o da pilha, ou o que já existia no `already_enabled`). */
  bucket: bucketName.nullable(),
  enabledAt: z.iso.datetime().nullable(),
  enabledBy: z.string().max(64).nullable(),
  disabledAt: z.iso.datetime().nullable(),
  disabledBy: z.string().max(64).nullable(),
  /** Os atributos do log como a Verax os leu antes de ligar. */
  previous: z
    .strictObject({
      enabled: z.boolean(),
      bucket: bucketName.nullable(),
      prefix: z.string().max(512).nullable(),
    })
    .nullable(),
});
export type WebAlbLogging = z.infer<typeof webAlbLoggingSchema>;
