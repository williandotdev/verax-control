import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { HostingConfig } from '../../src/hosting';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * Glob do Firebase Hosting, só nas formas que a configuração do painel usa (`**` e `/pasta/**`). Outra forma faz o
 * servidor falhar, para o teste não divergir em silêncio da produção quando a configuração mudar.
 */
function matches(glob: string, path: string): boolean {
  if (glob === '**') return true;
  if (glob.startsWith('/') && glob.endsWith('/**') && !glob.slice(0, -3).includes('*')) {
    return path.startsWith(glob.slice(0, -2));
  }
  throw new Error(`glob sem suporte no servidor de teste: ${glob}`);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Sem configuração de site: o bundle servido por outra pessoa, em outro domínio, sem os cabeçalhos da Verax. */
const FOREIGN_HOST: HostingConfig = { headers: [], rewrites: [{ glob: '**', path: '/index.html' }] };

/**
 * Servidor estático que faz o papel do Firebase Hosting: uma pasta (o mesmo `dist`) e uma configuração por domínio,
 * no formato que o script de publicação manda para a API do Firebase. Como lá, os cabeçalhos valem pelo caminho
 * pedido, na ordem das regras (a última prevalece), e a reescrita só entra quando não há arquivo no caminho.
 */
export async function startHostingServer(options: {
  root: string;
  sites: ReadonlyMap<string, HostingConfig>;
  port: number;
}): Promise<{ close: () => Promise<void> }> {
  const root = resolve(options.root);

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    const config = options.sites.get(host) ?? FOREIGN_HOST;
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? '/', 'http://servidor').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const inside = (candidate: string): string | undefined => {
      const file = resolve(root, `.${candidate}`);
      return file.startsWith(root + sep) && isFile(file) ? file : undefined;
    };
    const rewrite = config.rewrites.find((rule) => matches(rule.glob, path));
    const file =
      inside(path.endsWith('/') ? `${path}index.html` : path) ?? (rewrite ? inside(rewrite.path) : undefined);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    };
    for (const rule of config.headers) {
      if (matches(rule.glob, path)) Object.assign(headers, rule.headers);
    }
    response.writeHead(200, headers).end(readFileSync(file));
  };

  const server = createServer(handle);
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port, '127.0.0.1', done);
  });
  return {
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
