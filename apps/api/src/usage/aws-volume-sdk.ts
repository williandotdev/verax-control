import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { isAwsRegion } from '@verax/shared';
import { AWS_CLIENT_OPTIONS, STS_FALLBACK_REGION } from '../aws/web-identity.js';
import type { ListPage, VolumeS3, VolumeS3Factory } from './aws-volume.js';

/**
 * O S3 de verdade da medição na origem (`aws-volume.ts`), carregado só quando a tarefa entra no worker. Só leitura:
 * `ListObjectsV2` e `GetObject` dos 4 últimos bytes, as mesmas permissões do papel que o Wazuh já usa. O bucket pode
 * estar em outra região: o cliente segue o redirecionamento.
 */
export const sdkVolumeS3: VolumeS3Factory = (credentials, region): VolumeS3 => {
  const client = new S3Client({
    region: isAwsRegion(region) ? region : STS_FALLBACK_REGION,
    credentials,
    followRegionRedirects: true,
    ...AWS_CLIENT_OPTIONS,
  });
  return {
    async list({ bucket, prefix, delimiter, continuation }, signal): Promise<ListPage> {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(delimiter !== undefined && { Delimiter: delimiter }),
          ...(continuation !== null && continuation !== undefined && { ContinuationToken: continuation }),
          MaxKeys: 1000,
        }),
        { abortSignal: signal },
      );
      return {
        objects: (response.Contents ?? []).flatMap((object) =>
          object.Key === undefined || object.Size === undefined || object.LastModified === undefined
            ? []
            : [{ key: object.Key, size: object.Size, lastModified: object.LastModified }],
        ),
        prefixes: (response.CommonPrefixes ?? []).flatMap((folder) =>
          folder.Prefix === undefined ? [] : [folder.Prefix],
        ),
        next: response.IsTruncated === true ? (response.NextContinuationToken ?? null) : null,
      };
    },
    async tail(bucket, key, signal): Promise<Uint8Array> {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=-4' }),
        {
          abortSignal: signal,
        },
      );
      return response.Body === undefined ? new Uint8Array() : response.Body.transformToByteArray();
    },
    destroy: () => client.destroy(),
  };
};
