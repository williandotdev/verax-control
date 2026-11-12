import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * As telas do console do responsável (`apps/console`, um app React compilado pelo Vite) servidas pelo próprio
 * `cp-admin`: a mesma origem da API, sem CORS e sem outro serviço. Os arquivos são o código do repositório público
 * (nenhum preço, custo ou segredo) e abrem sem sessão: é neles que está a tela de login (`/entrar`); não há tela de
 * cadastro (a conta nasce pela linha de comando do operador). Os dados só chegam pela API, depois da guarda global, que
 * exige a sessão. Só `GET` e `HEAD` fora de `/v1/` e de `/health`; o resto segue para o Nest (a API, com a guarda global, ou o 404).
 *
 * - `/assets/...` (nomes com hash do conteúdo): cache privado de um ano, `immutable`;
 * - caminho sem ponto no último trecho (as rotas do app, `/tabelas-de-preco/2026-11-v1`; versão não tem ponto): o
 *   `index.html`, sem cache;
 * - arquivo (com ponto no último trecho) que não existe: 404 (nunca o `index.html` no lugar de um script);
 * - arquivo oculto (`.algo`) ou fora da pasta (`..`): recusado pelo `send` do Express.
 */

/**
 * CSP das telas (a API continua com `default-src 'none'`): scripts, estilos, fontes e imagens só da própria origem,
 * chamadas só à própria API. Nada inline (o tema é aplicado por um arquivo, `theme-init.js`), nada embutido em frame.
 */
export const CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const ASSETS_PREFIX = '/assets/';
const IMMUTABLE_CACHE = 'private, max-age=31536000, immutable';
const NO_STORE = 'private, no-store';
const FILE_ERRORS: Readonly<Partial<Record<number, string>>> = {
  400: 'Requisição inválida',
  403: 'Sem permissão',
  404: 'Recurso não encontrado',
};

/**
 * Onde ficam os arquivos compilados do console, conferindo o `index.html`: na imagem, `/app/console` (o Dockerfile
 * copia `apps/console/dist` para lá, ao lado de `/app/dist`); no monorepo, `apps/console/dist` depois do
 * `pnpm --filter @verax/console build`. Nenhum dos dois: `undefined`, e o console não é servido (a API continua).
 */
export function resolveConsoleRoot(
  candidates: readonly URL[] = [
    new URL('../../console/', import.meta.url),
    new URL('../../../console/dist/', import.meta.url),
  ],
): string | undefined {
  for (const candidate of candidates) {
    const root = fileURLToPath(candidate);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminhos fixos relativos ao módulo
    if (existsSync(fileURLToPath(new URL('index.html', candidate)))) return root;
  }
  return undefined;
}

function isApiPath(path: string): boolean {
  return path === '/health' || path === '/v1' || path.startsWith('/v1/');
}

export interface ConsoleAssetsOptions {
  /** A pasta do build do console (`resolveConsoleRoot`). */
  root: string;
}

/** O middleware do Express que serve o console (registrado em `configureApp`, só com `ROLE=admin`). */
export function consoleAssets(options: ConsoleAssetsOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path)) {
      next();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(req.path);
    } catch {
      res.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, message: 'Requisição inválida' });
      return;
    }
    // Um ponto no último trecho é arquivo (inclusive os ocultos, `.env`, que o `send` recusa); sem ponto, rota do app.
    const isFile = path.slice(path.lastIndexOf('/') + 1).includes('.');
    res.setHeader('Content-Security-Policy', CONSOLE_CSP);
    res.setHeader('Cache-Control', isFile && path.startsWith(ASSETS_PREFIX) ? IMMUTABLE_CACHE : NO_STORE);
    res.sendFile(
      isFile ? path : 'index.html',
      { root: options.root, dotfiles: 'deny', index: false, cacheControl: false, lastModified: false },
      (error?: Error & { status?: number; statusCode?: number }) => {
        if (error === undefined || res.headersSent) return;
        const status = error.status ?? error.statusCode ?? HttpStatus.INTERNAL_SERVER_ERROR;
        if (status >= 500) {
          next(error);
          return;
        }
        // `send` recusa caminho malformado (400) e arquivo oculto ou fora da pasta (403); o resto é 404.
        const shown = status === 400 || status === 403 ? status : HttpStatus.NOT_FOUND;
        res.setHeader('Cache-Control', NO_STORE);
        res
          .status(shown)
          .json({ statusCode: shown, message: FILE_ERRORS[shown] ?? 'Recurso não encontrado' });
      },
    );
  };
}
