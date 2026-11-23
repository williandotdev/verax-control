import { GetRoleCommand, GetUserCommand, type IAMClient } from '@aws-sdk/client-iam';
import { AWS_READER_ROLE_NAME, parseReaderRoleTags } from '@verax/shared';
import { z } from 'zod';
import type { AwsReaderFacts } from './aws-connection-check.js';
import { AwsConnectionError, isTransientAwsError, type ReaderSession } from './web-identity.js';

/**
 * A leitura das tags do papel de leitura (onboarding self-service): a versão do template e as capacidades ligadas. É uma
 * chamada só, `iam:GetRole` no próprio papel ou, na VM própria do cliente (a sessão é a chave de um usuário IAM),
 * `iam:GetUser` sem nome, que devolve o dono da chave.
 *
 * Quem a usa: a conferência da conexão (`web-identity-checker.ts`, no "Verificar" e uma vez por dia) e o "Tentar de
 * novo" de uma fonte (`discovery/discovery-job.ts`), que não confia nas capacidades gravadas na conta: o cliente pode
 * ter acabado de atualizar a pilha.
 */

/** As tags do papel: o IAM aceita até 50, com chave de até 128 e valor de até 256 caracteres. */
const roleTagsSchema = z
  .array(z.object({ Key: z.string().max(128).optional(), Value: z.string().max(256).optional() }))
  .max(50);

/** O template v1: sem tags no papel, só com a descoberta (e os buckets cadastrados antes). */
export const TEMPLATE_V1_FACTS: AwsReaderFacts = parseReaderRoleTags([]);

/**
 * O que as tags dizem agora. A leitura negada (o template v1 não a permitia) ou sem tags é a v1; uma falha passageira
 * devolve null (o gravado na conta fica). O cancelamento e a sessão que caiu sobem.
 */
export async function readReaderFacts(
  iam: Pick<IAMClient, 'send'>,
  principal: ReaderSession['principal'],
  signal: AbortSignal,
): Promise<AwsReaderFacts | null> {
  let found: unknown;
  try {
    found =
      principal === 'iam_user'
        ? (await iam.send(new GetUserCommand({}), { abortSignal: signal })).User?.Tags
        : (await iam.send(new GetRoleCommand({ RoleName: AWS_READER_ROLE_NAME }), { abortSignal: signal }))
            .Role?.Tags;
  } catch (error) {
    if (signal.aborted || error instanceof AwsConnectionError) throw error;
    return isTransientAwsError(error) ? null : TEMPLATE_V1_FACTS;
  }
  const tags = roleTagsSchema.safeParse(found ?? []);
  // As tags vêm da conta do cliente: só a versão e os nomes das capacidades contam (`parseReaderRoleTags`).
  return tags.success ? parseReaderRoleTags(tags.data) : TEMPLATE_V1_FACTS;
}
