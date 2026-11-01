import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from './index.js';

describe('@verax/shared', () => {
  it('exporta o nome do produto', () => {
    expect(PRODUCT_NAME).toBe('Verax Control');
  });
});
