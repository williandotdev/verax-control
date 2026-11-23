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
 * Quem a usa: a conferência da conexão (`web-identity-checker.ts`, no "Verificar" e uma vez por dia) e a tarefa
 * `aws-discovery` (`discovery/discovery-job.ts`), no começo de toda descoberta e no "Tentar de novo" de uma fonte: ela
 * não confia nas capacidades gravadas na conta, porque o cliente pode ter acabado de atualizar a pilha.
 *
 * **A recusa tem dois sentidos.** O papel do template v1 não podia ler as próprias tags, então a leitura negada é a v1.
 * Mas uma sessão que deixou de valer (revogada no console) também recusa tudo. Quem acabou de provar que a sessão vale
 * (a conferência da conexão, depois de ler os buckets) trata a recusa como a v1 (`readReaderFacts`). Quem ainda não
 * provou (a descoberta, a sondagem) recebe os três resultados (`readReaderTags`) e decide com o resto do que leu.
 */

/** As tags do papel: o IAM aceita até 50, com chave de até 128 e valor de até 256 caracteres. */
const roleTagsSchema = z
  .array(z.object({ Key: z.string().max(128).optional(), Value: z.string().max(256).optional() }))
  .max(50);

/** O template v1: sem tags no papel, só com a descoberta (e os buckets cadastrados antes). */
export const TEMPLATE_V1_FACTS: AwsReaderFacts = parseReaderRoleTags([]);

export type ReaderTagsReading =
  /** As tags foram lidas (sem tag nenhuma, é a v1). */
  | { status: 'read'; facts: AwsReaderFacts }
  /** A leitura foi recusada: o papel do template v1, ou uma sessão que deixou de valer. */
  | { status: 'refused' }
  /** Falha passageira (o limite de requisições, o tempo esgotado): não dá para dizer agora. */
  | { status: 'unavailable'; error: unknown };

/** O que a leitura das tags deu agora. O cancelamento e a sessão que caiu sobem. */
export async function readReaderTags(
  iam: Pick<IAMClient, 'send'>,
  principal: ReaderSession['principal'],
  signal: AbortSignal,
): Promise<ReaderTagsReading> {
  let found: unknown;
  try {
    found =
      principal === 'iam_user'
        ? (await iam.send(new GetUserCommand({}), { abortSignal: signal })).User?.Tags
        : (await iam.send(new GetRoleCommand({ RoleName: AWS_READER_ROLE_NAME }), { abortSignal: signal }))
            .Role?.Tags;
  } catch (error) {
    if (signal.aborted || error instanceof AwsConnectionError) throw error;
    return isTransientAwsError(error) ? { status: 'unavailable', error } : { status: 'refused' };
  }
  const tags = roleTagsSchema.safeParse(found ?? []);
  // As tags vêm da conta do cliente: só a versão e os nomes das capacidades contam (`parseReaderRoleTags`).
  return { status: 'read', facts: tags.success ? parseReaderRoleTags(tags.data) : TEMPLATE_V1_FACTS };
}

/**
 * O que as tags dizem agora, para quem já provou que a sessão vale: a leitura negada (o template v1 não a permitia) ou
 * sem tags é a v1; uma falha passageira devolve null (o gravado na conta fica).
 */
export async function readReaderFacts(
  iam: Pick<IAMClient, 'send'>,
  principal: ReaderSession['principal'],
  signal: AbortSignal,
): Promise<AwsReaderFacts | null> {
  const reading = await readReaderTags(iam, principal, signal);
  if (reading.status === 'read') return reading.facts;
  return reading.status === 'refused' ? TEMPLATE_V1_FACTS : null;
}
