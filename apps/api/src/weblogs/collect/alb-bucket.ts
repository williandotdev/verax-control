import { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { Sender } from '../../aws/discovery/clients.js';
import { type AlbObject, type AlbTarget, folderOf, ownObject } from './alb-target.js';

/**
 * O S3 de um balanceador: a única porta da leitura dos logs do ALB para a AWS. Só `ListObjectsV2` e `GetObject`, no bucket e
 * no prefixo exato do balanceador (conta, região, nome e id), pelos clientes da descoberta com a trava de só leitura. Nada é
 * gravado, marcado nem apagado na conta do cliente.
 *
 * A chave que volta da listagem não é confiável: só a que segue a gramática e é deste balanceador vira objeto, e só ela pode
 * ser aberta.
 */

/** Objetos por listagem (o máximo do S3). */
export const ALB_LIST_PAGE = 1_000;

export interface AlbPage {
  objects: AlbObject[];
  /** Chaves da pasta que não são arquivos de log deste balanceador: contadas, nunca abertas. */
  ignored: number;
  /** De onde a próxima página segue; null na última. */
  next: string | null;
}

/** A resposta do S3 sem o que a leitura precisa. */
export class AlbResponseError extends Error {
  constructor() {
    super('resposta do S3 fora do formato');
    this.name = 'InvalidResponse';
  }
}

export class AlbBucket {
  constructor(
    /** As listagens e as leituras de 4 bytes: tempo curto por chamada. */
    private readonly calls: Sender<S3Client>,
    /** A leitura dos objetos: o tempo máximo da chamada vale até o fim do corpo. */
    private readonly bodies: Sender<S3Client>,
    readonly target: AlbTarget,
  ) {}

  /** Uma página da pasta do dia, a partir de `after` (exclusive). */
  async list(day: string, after: string | null): Promise<AlbPage> {
    const prefix = folderOf(this.target, day);
    const response = await this.calls.send(
      new ListObjectsV2Command({
        Bucket: this.target.bucket,
        Prefix: prefix,
        MaxKeys: ALB_LIST_PAGE,
        ...(after !== null && { StartAfter: after }),
      }),
    );
    const page: AlbPage = { objects: [], ignored: 0, next: null };
    let last: string | null = null;
    for (const item of (response.Contents ?? []).slice(0, ALB_LIST_PAGE)) {
      const { Key: key, Size: size } = item;
      if (typeof key !== 'string') continue;
      last = key;
      const object =
        key.startsWith(prefix) && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
          ? ownObject(this.target, key, size)
          : null;
      if (object === null) page.ignored += 1;
      else page.objects.push(object);
    }
    // A página seguinte é pela última chave, e não pela continuação da AWS: dá para retomar em outra execução. Uma página
    // cortada que não anda seria um laço sem fim.
    if (response.IsTruncated === true && last !== null && (after === null || last > after)) page.next = last;
    return page;
  }

  /** O corpo do objeto, para ler em pedaços. Quem chama o consome inteiro ou o destrói. */
  async open(object: AlbObject): Promise<Readable> {
    this.assertOwn(object);
    const response = await this.bodies.send(
      new GetObjectCommand({ Bucket: this.target.bucket, Key: object.key }),
    );
    if (!(response.Body instanceof Readable)) throw new AlbResponseError();
    return response.Body;
  }

  /** Os 4 últimos bytes do objeto: o tamanho descompactado do gzip (`decompressedSize`). */
  async tail(object: AlbObject): Promise<Uint8Array> {
    this.assertOwn(object);
    const response = await this.calls.send(
      new GetObjectCommand({ Bucket: this.target.bucket, Key: object.key, Range: 'bytes=-4' }),
    );
    if (response.Body === undefined) return new Uint8Array();
    return (await response.Body.transformToByteArray()).slice(-4);
  }

  private assertOwn(object: AlbObject): void {
    if (ownObject(this.target, object.key, object.size) === null) {
      throw new Error('objeto fora do balanceador autorizado');
    }
  }
}
