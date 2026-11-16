import { z } from 'zod';
import { NODE_RELEASE_PATTERN } from '../common/config/env.schema.js';
import { ULID_PATTERN } from '../common/ulid.js';
import { MAX_STEP_POLL } from '../queue/step-queue.js';

/**
 * A atualização da frota (decisão de 16/11/2026; `docs/ARQUITETURA.md`, "Atualização da frota"): cada "Promover para a
 * frota" é uma rodada (`rollouts/{id}`) com um passo por nó (`rollouts/{id}/nodes/{chave}`). Os documentos são
 * estritos, como o do cliente, e não guardam segredo nem dado pessoal de cliente: só versões, nomes de VM e de site,
 * subdomínios e códigos.
 */

/** A rodada: andando, parada pelo responsável, parada na primeira falha, concluída ou abortada. */
export const ROLLOUT_STATES = ['running', 'paused', 'paused_on_failure', 'completed', 'aborted'] as const;
export type RolloutState = (typeof ROLLOUT_STATES)[number];

/**
 * O passo de um nó: na fila (`pending`), pedido ao host (`updating`), conferindo a API pública (`checking`), publicando o
 * painel dos destinos dele (`publishing`), e o fim: `done`, `failed`, `skipped` (o responsável pulou) ou `reverted`
 * (voltou para a versão de antes, a pedido do responsável).
 */
export const NODE_STATES = [
  'pending',
  'updating',
  'checking',
  'publishing',
  'done',
  'failed',
  'skipped',
  'reverted',
] as const;
export type NodeState = (typeof NODE_STATES)[number];
/** Os estados em que o nó está mudando: a rodada acompanha até o fim, mesmo parada. */
export const IN_FLIGHT_STATES: ReadonlySet<NodeState> = new Set(['updating', 'checking', 'publishing']);
/** Os estados que encerram o passo (o `failed` encerra até o responsável retomar). */
export const SETTLED_STATES: ReadonlySet<NodeState> = new Set(['done', 'skipped', 'reverted']);

/** As ondas: 0, a célula da Verax (a canária); 1, as outras células; 2, os nós dedicados, em lotes. */
export const WAVES = [0, 1, 2] as const;
export type Wave = (typeof WAVES)[number];

export const ROLLOUT_INTENTS = ['upgrade', 'rollback'] as const;
export type RolloutIntent = (typeof ROLLOUT_INTENTS)[number];

/** Quantos nós dedicados ao mesmo tempo na onda 2 (as células vão sempre uma de cada vez). */
export const MAX_CONCURRENCY = 5;
export const DEFAULT_CONCURRENCY = 1;
/** Quanto tempo o host tem para responder `ok` depois do pedido (o Wazuh do standard sobe em até 40 min). */
export const DEFAULT_NODE_TIMEOUT_MINUTES = 60;
/** Um teto para a rodada caber numa transação do Firestore (500 escritas, com a rodada e a auditoria). */
export const MAX_FLEET_NODES = 400;
/** Os destinos de painel de um nó (a célula tem um site por cliente dela, mais o da equipe). */
export const MAX_NODE_PANELS = 300;

/** `HH:MM-HH:MM` no horário de Brasília, a regra do atualizador do host (`infra/node/bin/update.sh`). */
export const UPDATE_WINDOW_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** A chave de um nó na rodada: `cell-<célula>` ou `tenant-<id do cliente>`. */
export const NODE_KEY_PATTERN = /^(cell-[a-z][a-z0-9-]{1,30}[a-z0-9]|tenant-[0-9A-HJKMNP-TV-Z]{26})$/;

const releaseSchema = z.string().regex(NODE_RELEASE_PATTERN);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const gcpProject = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const shortCode = z.string().regex(/^[a-z][a-z0-9_:]{0,63}$/);

/** A versão como a rodada a usa: lida do manifesto assinado no bucket de releases, com o bundle do painel. */
export const rolloutReleaseSchema = z.strictObject({
  release: releaseSchema,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  packageSha256: sha256,
  panel: z.strictObject({ object: z.string().max(200), sha256 }),
});
export type RolloutRelease = z.infer<typeof rolloutReleaseSchema>;

/** Um site do painel que anda com o nó. */
export const panelTargetSchema = z.strictObject({
  project: gcpProject,
  siteId: z.string().regex(/^[a-z0-9-]{6,63}$/),
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,14}[a-z0-9]$/),
});
export type PanelTarget = z.infer<typeof panelTargetSchema>;

/** A VM do nó. */
export const nodeTargetSchema = z.strictObject({
  project: gcpProject,
  zone: z.string().regex(/^[a-z]+-[a-z]+[0-9]-[a-z]$/),
  instance: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .refine((value) => !value.endsWith('-')),
});
export type NodeTarget = z.infer<typeof nodeTargetSchema>;

/**
 * O que o passo do nó está fazendo: a atualização da rodada, ou a volta para a versão de antes (pedida pelo
 * responsável num nó). As duas pedem a versão ao host, conferem a API e publicam o painel dessa versão.
 */
export const nodeOperationSchema = z.strictObject({
  kind: z.enum(['update', 'revert']),
  release: rolloutReleaseSchema,
  intent: z.enum(ROLLOUT_INTENTS),
});
export type NodeOperation = z.infer<typeof nodeOperationSchema>;

/** Documento `rollouts/{id}`. */
export const rolloutSchema = z.strictObject({
  release: rolloutReleaseSchema,
  intent: z.enum(ROLLOUT_INTENTS),
  state: z.enum(ROLLOUT_STATES),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY),
  window: z.string().regex(UPDATE_WINDOW_PATTERN).optional(),
  nodeTimeoutMinutes: z.number().int().min(10).max(240),
  /** `owner:<e-mail>`, como na auditoria. */
  createdBy: z.string().max(260),
  createdAt: z.date(),
  updatedAt: z.date(),
  finishedAt: z.date().optional(),
  /** O número da próxima volta (`fleet.tick`): uma entrega com outro número é repetida ou velha. */
  nextTick: z.number().int().min(0).max(MAX_STEP_POLL),
  /** A volta em andamento (uma entrega repetida ao mesmo tempo espera), com prazo. */
  lease: z.strictObject({ tick: z.number().int().min(0), until: z.date() }).optional(),
  /** A falha que parou a rodada (a primeira), até o responsável retomar. */
  failure: z
    .strictObject({ nodeKey: z.string().regex(NODE_KEY_PATTERN), code: shortCode, at: z.date() })
    .optional(),
  totals: z.strictObject({
    nodes: z.number().int().min(0),
    pending: z.number().int().min(0),
    inFlight: z.number().int().min(0),
    done: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    reverted: z.number().int().min(0),
  }),
});
export type Rollout = z.infer<typeof rolloutSchema>;
export interface RolloutRecord extends Rollout {
  id: string;
}

/** Documento `rollouts/{id}/nodes/{chave}`. */
export const rolloutNodeSchema = z.strictObject({
  kind: z.enum(['cell', 'dedicated']),
  wave: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  /** A ordem dentro da onda. */
  order: z.number().int().min(0),
  /** O que o console mostra: o id da célula ou o subdomínio do cliente. */
  label: z.string().max(64),
  tenantId: z.string().regex(ULID_PATTERN).optional(),
  cellId: z.string().max(32).optional(),
  target: nodeTargetSchema,
  /** A API pública onde a conferência depois do host olha (`/health` e `/health/ready`). */
  apiOrigin: z.url({ protocol: /^https$/ }).max(300),
  panels: z.array(panelTargetSchema).max(MAX_NODE_PANELS),
  state: z.enum(NODE_STATES),
  operation: nodeOperationSchema.optional(),
  /** Começa já, fora da ordem das ondas e mesmo com a rodada parada (a volta pedida pelo responsável). */
  forced: z.boolean().optional(),
  /** A tentativa (cada uma é um pedido novo ao host: o mesmo pedido nunca roda duas vezes lá). */
  attempt: z.number().int().min(0),
  request: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/)
    .optional(),
  /** Quando o pedido chegou aos metadados da VM (o prazo do host conta daqui). */
  requestedAt: z.date().optional(),
  /** A versão do nó antes da rodada (o release, o commit ou `unknown`). */
  fromVersion: z.string().max(64).optional(),
  /** O último `update-state` que o host relatou. */
  nodeState: z.string().max(40).optional(),
  healthPolls: z.number().int().min(0),
  /** Quantos sites do painel já receberam a versão (na ordem de `panels`). */
  panelsDone: z.number().int().min(0),
  errorCode: shortCode.optional(),
  startedAt: z.date().optional(),
  finishedAt: z.date().optional(),
  updatedAt: z.date(),
  /** Sobe a cada gravação: a volta só grava o que calculou se ninguém mexeu no nó no meio. */
  rev: z.number().int().min(0),
});
export type RolloutNode = z.infer<typeof rolloutNodeSchema>;
export interface RolloutNodeRecord extends RolloutNode {
  key: string;
}
