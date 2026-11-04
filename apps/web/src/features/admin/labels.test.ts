import { CLOUDFLARE_BLOCKING_ERRORS, isCloudflareBlockingError } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { connectionErrorHint } from './labels';

describe('explicação do erro de coleta (cartão da conta)', () => {
  it('todo erro que para a coleta do Cloudflare tem explicação', () => {
    for (const code of CLOUDFLARE_BLOCKING_ERRORS) {
      expect(isCloudflareBlockingError(code)).toBe(true);
      expect(connectionErrorHint(code)).toMatch(/token/);
    }
  });

  it('erros passageiros e de zona têm explicação; os outros códigos ficam só como tipo do erro', () => {
    expect(connectionErrorHint('rate_limited')).toMatch(/limitou/);
    expect(connectionErrorHint('zone_not_found')).toMatch(/zonas/);
    expect(connectionErrorHint('AccessDenied')).toBeNull();
    expect(connectionErrorHint('toString')).toBeNull();
    expect(isCloudflareBlockingError('rate_limited')).toBe(false);
    expect(isCloudflareBlockingError(null)).toBe(false);
  });
});
