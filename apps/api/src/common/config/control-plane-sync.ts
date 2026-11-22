import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { NODE_PLATFORMS, NODE_SYNC_PATH } from '@verax/shared';
import { z } from 'zod';
import type { NodeMode } from './cell.js';
import { isHttpsOrigin } from './sso.js';

/**
 * Sincronização do nó dedicado com o plano de controle (a tarefa `control-plane-sync` do worker; `docs/ARQUITETURA.md`,
 * "Sincronização com o plano de controle"): a cada 5 min, o worker conta ao `cp-public` o que aplicou e recebe as fontes
 * de log que a Verax cadastrou no console. O `start.sh` liga no modo cliente (`CUSTOMER_MODE=true`), nas duas
 * plataformas, nunca na célula:
 * - `CONTROL_PLANE_SYNC=true` liga a tarefa (sem a linha, desligada: o nó da Verax e o ambiente local);
 * - `CONTROL_PLANE_ORIGIN`, a origem https da API pública do plano de controle (o padrão é a de produção);
 * - no nó da GCP, a identidade é o token do Google da conta de serviço do nó (exige `NODE_SA_UNIQUE_ID`);
 * - na VM própria do cliente (`NODE_PLATFORM=vm`), sem identidade do Google, a chave do nó que o registro deixou no
 *   cofre local, num arquivo do tmpfs montado só leitura no worker (`CONTROL_PLANE_NODE_KEY_FILE`). A chave nunca vem
 *   pelo ambiente, que o Docker grava no disco na configuração do contêiner.
 * - `VERAX_NODE_COMMIT`, o commit instalado (o nó o informa a cada chamada);
 * - `CONTROL_PLANE_USERS` (padrão true): os usuários do cliente que a Verax pede no console. Com false (o interruptor do
 *   cliente no `node.conf`), o nó continua anunciando a capacidade, mas recusa cada pedido com `users_disabled`, para
 *   o console mostrar o motivo.
 */

/** A origem padrão: o site `conta` do Firebase Hosting, que repassa ao `cp-public` (a mesma do `verax-install.sh`). */
export const DEFAULT_CONTROL_PLANE_ORIGIN = 'https://conta.veraxsistemas.com.br';

/** A chave do nó: 32 bytes em base64url (43 caracteres), como o registro a entrega (`re_secret_token`). */
const NODE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const HIDDEN_NODE_KEY = '[chave do nó]';

/**
 * A chave do nó da VM própria, lida do arquivo: o valor fica num campo privado, não vira JSON (o que o logger
 * serializa) nem aparece ao inspecionar o objeto; só sai por `value()`, para o cabeçalho `Authorization`.
 */
export class ControlPlaneNodeKey {
  readonly #key: string;

  constructor(key: string) {
    if (!NODE_KEY_PATTERN.test(key)) throw new Error('chave do nó fora do formato');
    this.#key = key;
  }

  value(): string {
    return this.#key;
  }

  toJSON(): string {
    return HIDDEN_NODE_KEY;
  }

  toString(): string {
    return HIDDEN_NODE_KEY;
  }

  [inspect.custom](): string {
    return HIDDEN_NODE_KEY;
  }
}

/** Como o nó se identifica no plano de controle: o token do Google (nó da GCP) ou a chave do nó (VM própria). */
export type ControlPlaneCredential =
  { kind: 'gcp_identity' } | { kind: 'node_key'; key: ControlPlaneNodeKey };

export interface ControlPlaneSyncConfig {
  /** A origem https do plano de controle (sem caminho). */
  origin: string;
  /** O endereço da rota: `<origem>/v1/node-sync`, que também é o audience do token do Google. */
  url: string;
  /** O commit instalado (`VERAX_NODE_COMMIT`). */
  commit: string;
  credential: ControlPlaneCredential;
  /** Cria os usuários pedidos no console (`CONTROL_PLANE_USERS`); desligado, recusa cada pedido com `users_disabled`. */
  users: boolean;
}

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'], { error: 'use true ou false' })
    .default(fallback)
    .transform((value) => value === 'true');

/** As variáveis da sincronização no worker, como o `start.sh` as escreve no `worker.env`. */
export const controlPlaneSyncEnvShape = {
  CONTROL_PLANE_SYNC: flag('false'),
  CONTROL_PLANE_USERS: flag('true'),
  CONTROL_PLANE_ORIGIN: z
    .string()
    .refine(isHttpsOrigin, {
      error:
        'deve ser só a origem https do plano de controle, sem caminho (ex.: https://conta.exemplo.com.br)',
    })
    .default(DEFAULT_CONTROL_PLANE_ORIGIN),
  CONTROL_PLANE_NODE_KEY_FILE: z
    .string()
    .regex(/^\/[\w./-]+$/, { error: 'deve ser o caminho absoluto do arquivo da chave do nó' })
    .optional(),
};

interface ControlPlaneSyncEnv {
  CONTROL_PLANE_SYNC: boolean;
  CONTROL_PLANE_USERS: boolean;
  CONTROL_PLANE_ORIGIN: string;
  CONTROL_PLANE_NODE_KEY_FILE?: string | undefined;
  NODE_MODE: NodeMode;
  NODE_PLATFORM: (typeof NODE_PLATFORMS)[number];
  NODE_SA_UNIQUE_ID?: string | undefined;
  VERAX_NODE_COMMIT?: string | undefined;
}

/**
 * As regras entre as variáveis: nunca na célula (ela tem o canal dela); no nó da GCP, o ID da conta de serviço (é o
 * `sub` do token que o plano de controle confere); na VM própria, o arquivo da chave (que só existe lá); e o commit.
 */
export function checkControlPlaneSyncEnv(env: ControlPlaneSyncEnv, ctx: z.RefinementCtx): void {
  if (env.CONTROL_PLANE_NODE_KEY_FILE !== undefined && env.NODE_PLATFORM !== 'vm') {
    ctx.addIssue({
      code: 'custom',
      path: ['CONTROL_PLANE_NODE_KEY_FILE'],
      message: 'só existe com NODE_PLATFORM=vm (o nó da GCP se identifica com o token do Google)',
    });
  }
  if (!env.CONTROL_PLANE_SYNC) return;
  if (env.NODE_MODE === 'cell') {
    ctx.addIssue({
      code: 'custom',
      path: ['CONTROL_PLANE_SYNC'],
      message: 'não existe com NODE_MODE=cell (a célula tem o canal dela com o plano de controle)',
    });
  }
  if (env.NODE_PLATFORM === 'gcp' && env.NODE_SA_UNIQUE_ID === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['NODE_SA_UNIQUE_ID'],
      message:
        'obrigatória com CONTROL_PLANE_SYNC=true no nó da GCP (o plano de controle confere o token do nó)',
    });
  }
  if (env.NODE_PLATFORM === 'vm' && env.CONTROL_PLANE_NODE_KEY_FILE === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['CONTROL_PLANE_NODE_KEY_FILE'],
      message: 'obrigatória com CONTROL_PLANE_SYNC=true na VM própria (a chave do nó do registro)',
    });
  }
  if (env.VERAX_NODE_COMMIT === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['VERAX_NODE_COMMIT'],
      message: 'obrigatória com CONTROL_PLANE_SYNC=true (a versão que o nó informa ao plano de controle)',
    });
  }
}

/** O conteúdo do arquivo da chave (sem a quebra de linha do fim); a falha cita a variável, nunca o caminho nem o valor. */
function readNodeKeyFile(path: string): ControlPlaneNodeKey {
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho da configuração, não do request
    content = readFileSync(path, 'utf8');
  } catch {
    throw new Error('não foi possível ler o arquivo da chave do nó');
  }
  const key = content.replace(/\r?\n$/, '');
  if (!NODE_KEY_PATTERN.test(key))
    throw new Error('o arquivo não tem a chave do nó (43 caracteres em base64url)');
  return new ControlPlaneNodeKey(key);
}

/**
 * A sincronização num objeto só (null, desligada), com a chave do nó já lida. Roda depois do `superRefine`: com
 * `CONTROL_PLANE_SYNC=true`, as regras de `checkControlPlaneSyncEnv` já passaram.
 */
export function controlPlaneSyncConfigOf(
  env: ControlPlaneSyncEnv,
  ctx: z.RefinementCtx,
): ControlPlaneSyncConfig | null {
  if (!env.CONTROL_PLANE_SYNC || env.VERAX_NODE_COMMIT === undefined) return null;
  let credential: ControlPlaneCredential;
  if (env.NODE_PLATFORM === 'vm') {
    if (env.CONTROL_PLANE_NODE_KEY_FILE === undefined) return null;
    try {
      credential = { kind: 'node_key', key: readNodeKeyFile(env.CONTROL_PLANE_NODE_KEY_FILE) };
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONTROL_PLANE_NODE_KEY_FILE'],
        message: (error as Error).message,
      });
      return null;
    }
  } else {
    credential = { kind: 'gcp_identity' };
  }
  return {
    origin: env.CONTROL_PLANE_ORIGIN,
    url: `${env.CONTROL_PLANE_ORIGIN}${NODE_SYNC_PATH}`,
    commit: env.VERAX_NODE_COMMIT,
    credential,
    users: env.CONTROL_PLANE_USERS,
  };
}
