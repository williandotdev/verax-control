import type { PanelBundle } from '../provisioning/panel-bundle.js';
import {
  loadPanelBundle,
  memoizedBundle,
  publishPanelRelease,
  releaseOfLabels,
} from '../provisioning/panel-publish.js';
import type { ProvisioningApis } from '../provisioning/provisioning-settings.js';
import { readReleaseManifest } from '../provisioning/release-manifest.js';
import type { NodeTarget, PanelTarget, RolloutRelease } from './fleet.schema.js';

/**
 * As chaves do pedido de versão nos metadados da VM (o contrato com `infra/node/bin/update.sh`; o módulo `node` do
 * Terraform as ignora). A janela, quando a rodada não tem, sai dos metadados.
 */
export const RELEASE_METADATA_KEYS = {
  release: 'verax-node-release',
  sha256: 'verax-node-release-sha256',
  request: 'verax-node-release-request',
  intent: 'verax-node-release-intent',
  window: 'verax-update-window',
} as const;

/** O pedido de versão para um nó. */
export interface NodeReleaseRequest {
  release: string;
  packageSha256: string;
  request: string;
  intent: 'upgrade' | 'rollback';
  window?: string;
}

/** O que o motor da frota faz fora do Firestore. Em produção, as APIs do Google e a sonda pública; nos testes, dublês. */
export interface FleetCloud {
  /** Os guest attributes do espaço `verax/` da VM (sem o espaço na chave). */
  guestAttributes(target: NodeTarget): Promise<Map<string, string>>;
  /** Grava o pedido nos metadados da VM, sem tocar nas outras chaves. */
  requestRelease(target: NodeTarget, request: NodeReleaseRequest): Promise<void>;
  /** `GET /health` e `/health/ready` na API pública do nó (pelo túnel). */
  apiHealthy(apiOrigin: string): Promise<boolean>;
  /** Um carregador do bundle do painel da versão (lido do bucket uma vez por carregador). */
  panelBundle(release: RolloutRelease): () => Promise<PanelBundle>;
  /** Publica o bundle num site; `false` quando o site já estava nessa versão. */
  publishPanel(
    site: PanelTarget,
    apiOrigin: string,
    release: RolloutRelease,
    bundle: () => Promise<PanelBundle>,
  ): Promise<boolean>;
  /** A versão publicada num site (os rótulos da liberação mais recente), se for uma da frota. */
  siteRelease(site: PanelTarget): Promise<string | undefined>;
  /** A versão conferida no bucket de releases (a assinatura e o manifesto), com o bundle do painel. */
  readRelease(release: string): Promise<RolloutRelease>;
  /** As versões no bucket de releases (as pastas `node-vX.Y.Z`). */
  listReleases(): Promise<string[]>;
}

/** A versão não tem o bundle do painel no manifesto: o painel não teria como andar junto. */
export class ReleaseWithoutPanelError extends Error {
  constructor() {
    super('a versão não tem o bundle do painel');
    this.name = 'ReleaseWithoutPanelError';
  }
}

/** Uma nova leitura dos metadados quando outra escrita passou no meio (412): poucas vezes. */
const METADATA_ATTEMPTS = 3;

export function mergeReleaseMetadata(
  items: readonly { key: string; value: string }[],
  request: NodeReleaseRequest,
): { key: string; value: string }[] {
  const ours = new Set<string>(Object.values(RELEASE_METADATA_KEYS));
  const kept = items.filter((item) => !ours.has(item.key));
  const added = [
    { key: RELEASE_METADATA_KEYS.release, value: request.release },
    { key: RELEASE_METADATA_KEYS.sha256, value: request.packageSha256 },
    { key: RELEASE_METADATA_KEYS.request, value: request.request },
    { key: RELEASE_METADATA_KEYS.intent, value: request.intent },
    ...(request.window === undefined ? [] : [{ key: RELEASE_METADATA_KEYS.window, value: request.window }]),
  ];
  return [...kept, ...added];
}

export class GoogleFleetCloud implements FleetCloud {
  constructor(
    private readonly apis: ProvisioningApis,
    private readonly releaseBucket: string,
  ) {}

  guestAttributes(target: NodeTarget): Promise<Map<string, string>> {
    return this.apis.compute.guestAttributes(target.project, target.zone, target.instance);
  }

  async requestRelease(target: NodeTarget, request: NodeReleaseRequest): Promise<void> {
    for (let attempt = 1; attempt <= METADATA_ATTEMPTS; attempt += 1) {
      const current = await this.apis.compute.instanceMetadata(target.project, target.zone, target.instance);
      const outcome = await this.apis.compute.setInstanceMetadata(
        target.project,
        target.zone,
        target.instance,
        {
          fingerprint: current.fingerprint,
          items: mergeReleaseMetadata(current.items, request),
        },
      );
      if (outcome === 'set') return;
    }
    throw new MetadataConflictError();
  }

  apiHealthy(apiOrigin: string): Promise<boolean> {
    return this.apis.probe.apiHealthy(apiOrigin);
  }

  panelBundle(release: RolloutRelease): () => Promise<PanelBundle> {
    return memoizedBundle(() => loadPanelBundle(this.apis.storage, this.releaseBucket, release));
  }

  async publishPanel(
    site: PanelTarget,
    apiOrigin: string,
    release: RolloutRelease,
    bundle: () => Promise<PanelBundle>,
  ): Promise<boolean> {
    const result = await publishPanelRelease(
      this.apis.firebase,
      { siteId: site.siteId, slug: site.slug, apiOrigin },
      release,
      bundle,
    );
    return result.published;
  }

  async siteRelease(site: PanelTarget): Promise<string | undefined> {
    return releaseOfLabels(await this.apis.firebase.latestReleaseLabels(site.siteId));
  }

  async readRelease(release: string): Promise<RolloutRelease> {
    const info = await readReleaseManifest(
      this.apis.storage,
      this.releaseBucket,
      release,
      this.apis.releaseKeys,
    );
    if (info.panel === undefined) throw new ReleaseWithoutPanelError();
    return {
      release: info.release,
      commit: info.commit,
      packageSha256: info.packageSha256,
      panel: info.panel,
    };
  }

  listReleases(): Promise<string[]> {
    return this.apis.storage.listPrefixes(this.releaseBucket);
  }
}

/** Os metadados mudaram três vezes seguidas no meio da leitura: a volta seguinte tenta de novo. */
export class MetadataConflictError extends Error {
  constructor() {
    super('os metadados da VM mudaram durante a gravação');
    this.name = 'MetadataConflictError';
  }
}
