import { describe, expect, it } from 'vitest';
import { PROVISIONING_PROGRESS } from '../status/status-view.js';
import { CloudApiError } from './cloud-http.js';
import { ExecutorInputError } from './executor-env.js';
import { PanelBundleError } from './panel-bundle.js';
import {
  DefinitiveStepError,
  definitiveCodeOf,
  nextStepOf,
  PROVISIONING_STEPS,
} from './provisioning-engine.js';
import { ReleaseManifestError } from './release-manifest.js';

describe('motor do provisionamento', () => {
  it('os passos são os da página de status, na mesma ordem', () => {
    expect([...PROVISIONING_STEPS]).toEqual(PROVISIONING_PROGRESS.map((entry) => entry.step));
    expect(nextStepOf('preflight')).toBe('cloudflare.tunnel');
    expect(nextStepOf('access.ready')).toBeUndefined();
  });

  it('o que para de vez e o que repete', () => {
    expect(definitiveCodeOf(new DefinitiveStepError('panel_bundle_missing'))).toBe('panel_bundle_missing');
    expect(definitiveCodeOf(new ReleaseManifestError('release_manifest_invalid'))).toBe(
      'release_manifest_invalid',
    );
    expect(definitiveCodeOf(new PanelBundleError('panel_bundle_invalid'))).toBe('panel_bundle_invalid');
    expect(definitiveCodeOf(new ExecutorInputError('BOOTSTRAP_ADMIN_EMAIL'))).toBe('executor_input_invalid');
    expect(definitiveCodeOf(new CloudApiError('cloudflare', 'tunnel_list', 403))).toBe('cloudflare_denied');
    expect(definitiveCodeOf(new CloudApiError('firebase', 'site_create', 401))).toBe('firebase_denied');
    expect(definitiveCodeOf(new CloudApiError('compute', 'guest_attributes', 404))).toBe('compute_not_found');
    expect(definitiveCodeOf(new CloudApiError('run', 'job_run', 400))).toBe('run_rejected');
    for (const status of [0, 408, 429, 500, 502, 503]) {
      expect(definitiveCodeOf(new CloudApiError('storage', 'object_read', status))).toBeUndefined();
    }
    expect(definitiveCodeOf(new Error('contenção do Firestore'))).toBeUndefined();
  });
});
