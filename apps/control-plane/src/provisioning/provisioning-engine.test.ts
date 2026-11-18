import { describe, expect, it } from 'vitest';
import { CUSTOMER_PROVISIONING_PROGRESS, PROVISIONING_PROGRESS } from '../status/status-view.js';
import { CloudApiError } from './cloud-http.js';
import { ExecutorInputError } from './executor-env.js';
import { PanelBundleError } from './panel-bundle.js';
import {
  CUSTOMER_PROVISIONING_STEPS,
  DefinitiveStepError,
  definitiveCodeOf,
  nextStepOf,
  PROVISIONING_STEPS,
  stepIndex,
  stepsFor,
} from './provisioning-engine.js';
import { ReleaseManifestError } from './release-manifest.js';

describe('motor do provisionamento', () => {
  it('os passos são os da página de status, na mesma ordem', () => {
    expect([...PROVISIONING_STEPS]).toEqual(PROVISIONING_PROGRESS.map((entry) => entry.step));
    expect(nextStepOf('preflight')).toBe('cloudflare.tunnel');
    expect(nextStepOf('access.ready')).toBeUndefined();
  });

  it('a sequência do gerenciado não muda; a da VM do cliente é a reduzida, também na página de status', () => {
    expect([...PROVISIONING_STEPS]).toEqual([
      'preflight',
      'cloudflare.tunnel',
      'firebase.site',
      'terraform.apply',
      'terraform.wait',
      'secrets.smtp_password',
      'secrets.tunnel_token',
      'node.wait_ready',
      'node.health',
      'panel.domain_wait',
      'access.ready',
    ]);
    expect([...CUSTOMER_PROVISIONING_STEPS]).toEqual([
      'preflight',
      'cloudflare.tunnel',
      'firebase.site',
      'enrollment.wait',
      'node.health',
      'panel.domain_wait',
      'access.ready',
    ]);
    expect([...CUSTOMER_PROVISIONING_STEPS]).toEqual(
      CUSTOMER_PROVISIONING_PROGRESS.map((entry) => entry.step),
    );
    expect(stepsFor({})).toBe(PROVISIONING_STEPS);
    expect(stepsFor({ hosting: 'verax' })).toBe(PROVISIONING_STEPS);
    expect(stepsFor({ hosting: 'customer' })).toBe(CUSTOMER_PROVISIONING_STEPS);
    expect(nextStepOf('firebase.site', CUSTOMER_PROVISIONING_STEPS)).toBe('enrollment.wait');
    expect(nextStepOf('enrollment.wait', CUSTOMER_PROVISIONING_STEPS)).toBe('node.health');
    expect(nextStepOf('firebase.site')).toBe('terraform.apply');
    // Nenhum passo do Terraform, dos cofres ou da espera da VM na sequência reduzida, e vice-versa.
    for (const name of [
      'terraform.apply',
      'terraform.wait',
      'secrets.smtp_password',
      'secrets.tunnel_token',
    ]) {
      expect(stepIndex(name, CUSTOMER_PROVISIONING_STEPS)).toBe(-1);
    }
    expect(stepIndex('node.wait_ready', CUSTOMER_PROVISIONING_STEPS)).toBe(-1);
    expect(stepIndex('enrollment.wait')).toBe(-1);
    expect(nextStepOf('enrollment.wait')).toBeUndefined();
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
