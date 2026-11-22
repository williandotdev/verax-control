import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { AWS_READER_TEMPLATE_FILE } from '@verax/shared';
import type { Response } from 'express';
import { ApiError } from '../common/http/api-error.js';

/**
 * O template do papel de leitura sem chave da AWS (`infra/cloudformation/verax-control-reader.yaml`), servido pelo
 * próprio cp-admin num caminho fixo (`AWS_READER_TEMPLATE_PATH`), para o responsável baixar exatamente o arquivo
 * revisado no commit da imagem e mandar ao cliente (decisão D6 do plano da sincronização). Não é segredo (o repositório
 * é público), mas fica atrás da sessão do console, como toda rota `/v1/admin/...`.
 *
 * Onde está o arquivo: na imagem, `/app/cloudformation/` (o Dockerfile copia do repositório, ao lado de `/app/dist`);
 * no monorepo, o próprio `infra/cloudformation/`. Nenhum dos dois: 503 (o resto do console continua).
 */
export function resolveAwsReaderTemplate(
  candidates: readonly URL[] = [
    new URL(`../../cloudformation/${AWS_READER_TEMPLATE_FILE}`, import.meta.url),
    new URL(`../../../../infra/cloudformation/${AWS_READER_TEMPLATE_FILE}`, import.meta.url),
  ],
): string | undefined {
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminhos fixos relativos ao módulo
    if (existsSync(path)) return path;
  }
  return undefined;
}

let cached: Buffer | undefined;

/** O conteúdo do template, lido uma vez (a imagem é só leitura: o arquivo não muda com o processo no ar). */
function templateContent(): Buffer | undefined {
  if (cached !== undefined) return cached;
  const path = resolveAwsReaderTemplate();
  if (path === undefined) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho fixo resolvido acima
  cached = readFileSync(path);
  return cached;
}

@Controller('admin/aws-reader')
export class AwsReaderTemplateController {
  @Get(AWS_READER_TEMPLATE_FILE)
  template(@Res() res: Response): void {
    const content = templateContent();
    if (content === undefined) {
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'O template do papel de leitura não está nesta imagem.',
        'template_unavailable',
      );
    }
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${AWS_READER_TEMPLATE_FILE}"`);
    res.status(HttpStatus.OK).send(content);
  }
}
