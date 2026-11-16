import type { FirebaseHostingApi, StorageApi } from './google-apis.js';
import { MAX_BUNDLE_BYTES, openPanelBundle, type PanelBundle, siteHostingConfig } from './panel-bundle.js';
import { DefinitiveStepError } from './provisioning-engine.js';

/** O bundle do painel de uma versão, como o manifesto assinado o descreve (`release-manifest.ts`). */
export interface PanelRelease {
  release: string;
  panel: { object: string; sha256: string };
}

/** Um site do painel: onde publicar e de qual cliente é a API que a CSP libera. */
export interface PanelSite {
  siteId: string;
  slug: string;
  apiOrigin: string;
}

/**
 * Os rótulos que marcam a versão publicada num site: a versão e o começo do SHA-256 do bundle. É por eles que a
 * publicação não repete o mesmo bundle (provisionamento e frota) e que o console mostra a versão de cada site.
 */
export function panelLabels(release: PanelRelease): Record<string, string> {
  return {
    'verax-release': release.release.replaceAll('.', '-'),
    'verax-panel': release.panel.sha256.slice(0, 16),
  };
}

/** A versão (`node-vX.Y.Z`) dos rótulos de um site, ou `undefined` se não vieram de uma publicação desta. */
export function releaseOfLabels(labels: Record<string, string> | undefined): string | undefined {
  const value = labels?.['verax-release'];
  if (value === undefined || !/^node-v[0-9]{1,4}-[0-9]{1,4}-[0-9]{1,4}$/.test(value)) return undefined;
  const [major, minor, patch] = value.slice('node-v'.length).split('-');
  return `node-v${major}.${minor}.${patch}`;
}

/**
 * Lê e abre o bundle de uma versão no bucket de releases (o SHA-256 do manifesto conferido), uma vez por chamada de
 * quem publica em vários sites.
 */
export async function loadPanelBundle(
  storage: Pick<StorageApi, 'read'>,
  releaseBucket: string,
  release: PanelRelease,
): Promise<PanelBundle> {
  const archive = await storage.read(releaseBucket, release.panel.object, MAX_BUNDLE_BYTES);
  if (archive === undefined) throw new DefinitiveStepError('panel_bundle_missing');
  return openPanelBundle(archive, release.panel.sha256);
}

/**
 * Publica o bundle de uma versão num site, com a configuração do cliente do site (a API dele na CSP), a menos que a
 * liberação mais recente do site já seja dele (os rótulos). O bundle é lido só se precisar (`bundle()`): quem publica
 * em vários sites passa o mesmo carregador, e o arquivo sai do bucket uma vez.
 */
export async function publishPanelRelease(
  firebase: Pick<FirebaseHostingApi, 'latestReleaseLabels' | 'publish'>,
  site: PanelSite,
  release: PanelRelease,
  bundle: () => Promise<PanelBundle>,
): Promise<{ published: boolean; files: number; uploaded: number }> {
  const labels = panelLabels(release);
  const latest = await firebase.latestReleaseLabels(site.siteId);
  if (
    latest?.['verax-release'] === labels['verax-release'] &&
    latest?.['verax-panel'] === labels['verax-panel']
  ) {
    return { published: false, files: 0, uploaded: 0 };
  }
  const opened = await bundle();
  const hosting = siteHostingConfig(opened.template, site.slug, site.apiOrigin);
  const { uploaded } = await firebase.publish(site.siteId, opened.files, hosting, labels);
  return { published: true, files: opened.files.size, uploaded };
}

/** Um carregador que lê o bundle na primeira chamada e devolve o mesmo nas seguintes. */
export function memoizedBundle(load: () => Promise<PanelBundle>): () => Promise<PanelBundle> {
  let pending: Promise<PanelBundle> | undefined;
  return () => {
    pending ??= load();
    return pending;
  };
}
