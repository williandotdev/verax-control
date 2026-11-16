import type { FleetCloud, NodeReleaseRequest } from '../../src/fleet/fleet-cloud.js';
import { ReleaseWithoutPanelError } from '../../src/fleet/fleet-cloud.js';
import type { NodeTarget, PanelTarget, RolloutRelease } from '../../src/fleet/fleet.schema.js';
import type { PanelBundle } from '../../src/provisioning/panel-bundle.js';
import { ReleaseManifestError } from '../../src/provisioning/release-manifest.js';

/** Uma versão fictícia da frota, com o bundle do painel. */
export function fleetRelease(release: string, commitDigit = 'a'): RolloutRelease {
  return {
    release,
    commit: commitDigit.repeat(40),
    packageSha256: commitDigit.repeat(64),
    panel: { object: `${release}/panel-${commitDigit.repeat(40)}.tar.gz`, sha256: 'b'.repeat(64) },
  };
}

/**
 * A nuvem da frota em memória: os metadados de cada VM (o pedido), os guest attributes que o "host" grava (o teste
 * decide quando, com `host`), a API pública de cada nó, os sites do painel e o bucket de releases. Cada chamada entra
 * em `events`, na ordem: é por ela que os testes conferem que o painel só sai depois do nó.
 */
export class FakeFleetCloud implements FleetCloud {
  readonly events: string[] = [];
  readonly requests = new Map<string, NodeReleaseRequest>();
  readonly attributes = new Map<string, Map<string, string>>();
  readonly unhealthy = new Set<string>();
  readonly siteReleases = new Map<string, string>();
  readonly releases = new Map<string, RolloutRelease | 'no_panel' | 'invalid'>();
  /**
   * Falhas a lançar nas próximas chamadas de cada operação (`request`, `attributes`, `publish`), uma por chamada;
   * `undefined` deixa aquela chamada passar.
   */
  readonly failures = new Map<string, (Error | undefined)[]>();
  bundleLoads = 0;

  private fail(operation: string): void {
    const queue = this.failures.get(operation);
    const error = queue?.shift();
    if (error !== undefined) throw error;
  }

  async guestAttributes(target: NodeTarget): Promise<Map<string, string>> {
    this.events.push(`attributes:${target.instance}`);
    await Promise.resolve();
    this.fail('attributes');
    return new Map(this.attributes.get(target.instance) ?? []);
  }

  async requestRelease(target: NodeTarget, request: NodeReleaseRequest): Promise<void> {
    this.events.push(`request:${target.instance}:${request.release}:${request.intent}`);
    await Promise.resolve();
    this.fail('request');
    this.requests.set(target.instance, { ...request });
  }

  /** O host responde ao último pedido da VM (como o `update.sh` grava os guest attributes). */
  host(instance: string, state: string, error?: string): void {
    const request = this.requests.get(instance);
    if (request === undefined) throw new Error(`nenhum pedido para ${instance}`);
    const attributes = this.attributes.get(instance) ?? new Map<string, string>();
    attributes.set('update-request', request.request);
    attributes.set('update-release', request.release);
    attributes.set('update-state', state);
    if (error === undefined) attributes.delete('update-error');
    else attributes.set('update-error', error);
    this.attributes.set(instance, attributes);
  }

  apiHealthy(apiOrigin: string): Promise<boolean> {
    this.events.push(`health:${apiOrigin}`);
    return Promise.resolve(!this.unhealthy.has(apiOrigin));
  }

  /** Como o de produção: o carregador lê o bundle uma vez só (`bundleLoads` conta as leituras). */
  panelBundle(release: RolloutRelease): () => Promise<PanelBundle> {
    let loaded: Promise<PanelBundle> | undefined;
    return () => {
      if (loaded === undefined) {
        this.bundleLoads += 1;
        loaded = Promise.resolve({
          files: new Map([[`/index-${release.release}.html`, Buffer.from('x')]]),
          template: '{}',
        });
      }
      return loaded;
    };
  }

  async publishPanel(
    site: PanelTarget,
    apiOrigin: string,
    release: RolloutRelease,
    bundle: () => Promise<PanelBundle>,
  ): Promise<boolean> {
    this.events.push(`publish:${site.siteId}:${release.release}:${apiOrigin}`);
    this.fail('publish');
    if (this.siteReleases.get(site.siteId) === release.release) return false;
    await bundle();
    this.siteReleases.set(site.siteId, release.release);
    return true;
  }

  siteRelease(site: PanelTarget): Promise<string | undefined> {
    return Promise.resolve(this.siteReleases.get(site.siteId));
  }

  readRelease(release: string): Promise<RolloutRelease> {
    const value = this.releases.get(release);
    if (value === undefined) return Promise.reject(new ReleaseManifestError('release_manifest_missing'));
    if (value === 'no_panel') return Promise.reject(new ReleaseWithoutPanelError());
    if (value === 'invalid') return Promise.reject(new ReleaseManifestError('release_manifest_invalid'));
    return Promise.resolve(value);
  }

  listReleases(): Promise<string[]> {
    return Promise.resolve([...this.releases.keys()]);
  }
}
