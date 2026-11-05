import { describe, expect, it } from 'vitest';
import { buildDeletionRecord, UnsafeRecordValueError } from './deletion-record.js';

describe('registro de exclusão (e-mail da Exclusão 1)', () => {
  it('diz o que saiu, quando, e o que fica até a Exclusão 2; só subdomínio e datas', () => {
    const message = buildDeletionRecord({
      to: 'admin@cliente-demo-a.example',
      slug: 'cliente-demo-a',
      canceledAt: new Date('2026-11-05T12:00:00Z'),
      deletedAt: new Date('2026-12-05T12:00:00Z'),
      cryptoDestroyAfter: new Date('2027-02-10T12:00:00Z'),
    });
    expect(message.to).toBe('admin@cliente-demo-a.example');
    expect(message.subject).toBe('Registro de exclusão do ambiente cliente-demo-a');
    expect(message.text).toContain('excluído em 05/12/2026');
    expect(message.text).toContain('cancelada em 05/11/2026');
    expect(message.text).toContain('destruída em 10/02/2027');
    expect(message.html).not.toContain('<script');
    expect(message.text).not.toMatch(/senha:|password/i);
  });

  it('recusa um subdomínio fora do formato (nada vindo de fora entra no HTML)', () => {
    expect(() =>
      buildDeletionRecord({
        to: 'a@b.example',
        slug: '<b>x</b>',
        deletedAt: new Date('2026-12-05T12:00:00Z'),
      }),
    ).toThrow(UnsafeRecordValueError);
  });
});
