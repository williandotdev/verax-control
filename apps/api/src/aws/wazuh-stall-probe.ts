import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { type DiscoveryClientFactory, DiscoveryRunClients } from './discovery/clients.js';
import type { StallQuestion, WazuhStallProbe } from './wazuh-source-health.js';
import type { AwsReaderCredentials } from './web-identity.js';

/**
 * A conferência da origem de uma fonte contínua (a trilha do CloudTrail, os flow logs) que o Wazuh do nó não lê há mais
 * de 2 horas: há objeto novo no bucket que ele ainda não leu? Sem objeto novo, a conta só está quieta, e a fonte não é
 * marcada como parada.
 *
 * Uma listagem barata por pasta de dia (`ListObjectsV2`, `MaxKeys = 1`, a partir do último objeto lido), com a sessão de
 * leitura da conta e pelos clientes da descoberta: a trava de só leitura, o tempo máximo por chamada e nenhuma escrita.
 * Só nomes e datas de objetos; nenhum conteúdo é lido. O prefixo é o exato da conta (`…AWSLogs/<conta>/<serviço>/
 * <região>/<dia>/`), o que a política do papel de leitura aceita listar.
 */
export class S3StallProbe implements WazuhStallProbe {
  constructor(
    private readonly credentials: Pick<AwsReaderCredentials, 'session' | 'credentialsFor'>,
    private readonly clients: DiscoveryClientFactory,
  ) {}

  async hasUnreadObjects(question: StallQuestion, signal: AbortSignal): Promise<boolean | null> {
    const { accountId, homeRegion, bucket } = question;
    // A entrada no papel primeiro: recusada, nenhuma outra chamada (o erro sobe, e a fonte fica sem conferir).
    await this.credentials.session(accountId, homeRegion, signal);
    const clients = new DiscoveryRunClients(
      this.clients(this.credentials.credentialsFor(accountId, homeRegion), homeRegion),
      homeRegion,
      signal,
    );
    try {
      const s3 = clients.s3(null);
      for (const prefix of question.prefixes) {
        const listed = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1,
            ...(question.afterKey !== null && { StartAfter: question.afterKey }),
          }),
        );
        const first = listed.Contents?.[0];
        // O primeiro depois do último lido é o mais antigo ainda não lido: recente, o módulo ainda vai buscá-lo.
        if (first?.LastModified !== undefined && first.LastModified <= question.olderThan) return true;
      }
      return false;
    } finally {
      clients.destroy();
    }
  }
}
