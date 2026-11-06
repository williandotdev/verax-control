import { ExternalLink, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import type { TenantDetail } from '@/lib/api-types';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { WORKER_FAILURE_MESSAGES } from './labels';
import { useTenantInstallation } from './queries';

/** Só endereços `https` do GitHub viram link (a API já confere; aqui, de novo, antes de ir a um `href`). */
function githubHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function GithubLink({ url, children }: { url: string; children: ReactNode }) {
  const href = githubHref(url);
  if (href === undefined) return <span className="font-mono text-xs break-all">{url}</span>;
  return (
    <a
      href={href}
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}

/** O que fazer quando a versão não veio: o texto do código do cp-worker; senão, a mensagem da API. */
function installationError(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code !== undefined &&
    Object.hasOwn(WORKER_FAILURE_MESSAGES, error.code)
  ) {
    return WORKER_FAILURE_MESSAGES[error.code] ?? errorMessage(error);
  }
  return errorMessage(error);
}

/**
 * O que o responsável manda ao cliente que instala o ambiente na infraestrutura dele: a versão do nó (a vigente, lida e
 * conferida pelo cp-worker com a assinatura do manifesto), os endereços do release no GitHub, as imagens pelo digest, o
 * guia de instalação do repositório e as linhas do `node.conf` que o contrato define. Nada aqui é segredo: tudo é
 * público no release ou é do próprio contrato.
 */
export function InstallationPanel({ tenant }: { tenant: TenantDetail }) {
  const enabled = tenant.state !== 'deleted';
  const installation = useTenantInstallation(tenant.id, enabled);
  const data = installation.data;
  return (
    <section aria-labelledby="instalacao" className="space-y-3 rounded-xl border bg-surface p-4">
      <h2 id="instalacao" className="text-base font-semibold">
        Instalação na infraestrutura do cliente
      </h2>
      <p className="text-sm">
        Este ambiente roda na infraestrutura do cliente: a Verax não cria, não para, não liga nem apaga nada
        lá. Envie ao cliente a versão e o guia abaixo. Antes de instalar, ele confere a assinatura do
        manifesto com o <span className="font-mono">verify-release.sh</span>, como o guia mostra.
      </p>
      {!enabled && (
        <p className="text-sm text-muted-foreground">O contrato terminou: não há o que instalar.</p>
      )}
      {enabled && installation.isPending && <LoadingState label="Lendo a versão do nó" />}
      {installation.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert aria-hidden className="size-4 text-critical" />
            {installationError(installation.error)}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void installation.refetch()}>
            Tentar de novo
          </Button>
        </div>
      )}
      {data !== undefined && (
        <div className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Versão do nó</dt>
              <dd className="font-mono text-sm">{data.release}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Commit</dt>
              <dd className="font-mono text-xs break-all">{data.commit}</dd>
            </div>
            {data.releasedAt !== undefined && (
              <div>
                <dt className="text-xs text-muted-foreground">Publicada em</dt>
                <dd className="text-sm">{formatDateTime(data.releasedAt)}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-muted-foreground">Chave que assinou ({data.releaseKey.name})</dt>
              <dd className="font-mono text-xs break-all">SHA-256 {data.releaseKey.sha256}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Mande a impressão digital da chave por um canal do contrato (não pelo GitHub): é ela que o cliente
            compara antes de confiar no <span className="font-mono">verify-release.sh</span> da primeira
            instalação.
          </p>
          <ul aria-label="O que enviar ao cliente" className="space-y-1 text-sm">
            <li>
              <GithubLink url={data.guideUrl}>Guia de instalação na infraestrutura do cliente</GithubLink>
            </li>
            <li>
              <GithubLink url={data.releaseUrl}>Release {data.release} no GitHub</GithubLink>
            </li>
            <li>
              <GithubLink url={data.manifestUrl}>Manifesto assinado (manifest.json)</GithubLink>
              {' · '}
              <GithubLink url={data.signatureUrl}>Assinatura (manifest.json.sig)</GithubLink>
            </li>
            <li>
              <GithubLink url={data.package.url}>Pacote do nó (verax-node.tar.gz)</GithubLink>
              <span className="block font-mono text-xs break-all text-muted-foreground">
                SHA-256 {data.package.sha256}
              </span>
            </li>
          </ul>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Imagens, pelo digest</h3>
            <p className="text-xs text-muted-foreground">
              As do Verax no registro público do GitHub (sem login); as de terceiros, do registro de origem.
            </p>
            <ul aria-label="Imagens pelo digest" className="space-y-1 font-mono text-xs break-all">
              <li>{data.images.api}</li>
              <li>{data.images.migrate}</li>
              {data.thirdPartyImages.map((image) => (
                <li key={image}>{image}</li>
              ))}
            </ul>
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">O plano no node.conf do cliente</h3>
            <p className="text-xs text-muted-foreground">
              Os limites deste contrato, como o nó os lê (o resto do node.conf está no guia).
            </p>
            <pre
              aria-label="Linhas do node.conf do contrato"
              tabIndex={0}
              className="overflow-x-auto rounded-md border bg-surface-raised p-3 font-mono text-xs"
            >
              {data.nodeConf.map((line) => `${line.name}=${line.value}`).join('\n')}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
