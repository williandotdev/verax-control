import type { AwsSourceFeatures } from '@verax/shared';
import { z } from 'zod';
import type { NodeMode } from './cell.js';

/**
 * Ataques web pelos logs de acesso do ALB, na API e no worker: disponíveis por padrão (`AWS_WEB_LOGS_ENABLED`). Disponível não
 * lê nada: só o balanceador que o cliente autorizar no painel é lido. Com a linha em `false`, o balanceador é descoberto e mostrado como sempre (não coletado), nenhuma rota aceita autorizá-lo e
 * as de `/v1/web-logs` respondem 404. A API e o worker do mesmo nó têm de ter o mesmo valor.
 */
export const webLogsEnvShape = {
  AWS_WEB_LOGS_ENABLED: z
    .enum(['true', 'false'], { error: 'use true ou false' })
    .default('true')
    .transform((value) => value === 'true'),
};

/**
 * O que este nó tem ligado e muda o que ele coleta da AWS. Na célula compartilhada, a coleta da AWS não existe: a linha não
 * liga nada lá.
 */
export function awsSourceFeatures(config: {
  AWS_WEB_LOGS_ENABLED: boolean;
  NODE_MODE: NodeMode;
}): AwsSourceFeatures {
  return { webLogs: config.AWS_WEB_LOGS_ENABLED && config.NODE_MODE !== 'cell' };
}
