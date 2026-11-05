import { CLOUDFLARE_BLOCKING_ERRORS, isCloudflareBlockingError } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { cloudflareConnectionErrorHint } from './labels';

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
