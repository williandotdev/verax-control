import {
  AWS_CONNECTION_ERROR_CODES,
  AWS_CONNECTION_WARNING_CODES,
  CLOUDFLARE_BLOCKING_ERRORS,
  isCloudflareBlockingError,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { awsConnectionErrorHint, cloudflareConnectionErrorHint } from './labels';

describe('explicação do erro de coleta (cartão da conta)', () => {
  it('todo erro que para a coleta do Cloudflare tem explicação', () => {
    for (const code of CLOUDFLARE_BLOCKING_ERRORS) {
      expect(isCloudflareBlockingError(code)).toBe(true);
      expect(cloudflareConnectionErrorHint(code)).toMatch(/token/);
    }
  });

  it('erros passageiros e de zona têm explicação; os outros códigos ficam só como tipo do erro', () => {
    expect(cloudflareConnectionErrorHint('rate_limited')).toMatch(/limitou/);
    expect(cloudflareConnectionErrorHint('zone_not_found')).toMatch(/zonas/);
    expect(cloudflareConnectionErrorHint('AccessDenied')).toBeNull();
    expect(cloudflareConnectionErrorHint('toString')).toBeNull();
    expect(isCloudflareBlockingError('rate_limited')).toBe(false);
    expect(isCloudflareBlockingError(null)).toBe(false);
  });
});

describe('explicação do erro e do aviso da conexão da AWS (PR-V5)', () => {
  it('todo código da AWS tem explicação; os avisos dizem que a coleta continua', () => {
    for (const code of AWS_CONNECTION_ERROR_CODES) expect(awsConnectionErrorHint(code)).toBeTruthy();
    for (const code of AWS_CONNECTION_WARNING_CODES.filter((warning) => warning !== 'region_disabled')) {
      expect(awsConnectionErrorHint(code)).toMatch(/continua/);
    }
    expect(awsConnectionErrorHint('region_disabled')).toMatch(/us-east-1/);
  });

  it('o erro de bucket diz de qual fonte é o bucket; sem a fonte, um dos cadastrados', () => {
    expect(awsConnectionErrorHint('kms_denied:guardduty')).toMatch(
      /^Bucket do export do GuardDuty: o papel não decifra/,
    );
    expect(awsConnectionErrorHint('bucket_missing:cloudtrail')).toMatch(/^Bucket do CloudTrail: não existe/);
    expect(awsConnectionErrorHint('bucket_denied:waf')).toMatch(/^Bucket do WAF: /);
    expect(awsConnectionErrorHint('bucket_denied')).toMatch(/^Um dos buckets cadastrados: /);
    expect(awsConnectionErrorHint('trust_denied')).toMatch(/^A AWS recusou a entrada no papel/);
  });

  it('o que não é código da AWS fica sem explicação (o painel mostra só o tipo)', () => {
    for (const value of [
      'AccessDenied',
      'credential_rejected',
      'trust_denied:waf',
      'bucket_denied:outra',
      'toString',
    ]) {
      expect(awsConnectionErrorHint(value)).toBeNull();
    }
  });
});
