import { describe, expect, it } from 'vitest';
import {
  type PostureAccount,
  postureAccountSchema,
  type PostureCheck,
  postureCheckListQuerySchema,
  postureCheckSchema,
  postureOverviewSchema,
} from './posture.js';

const account: PostureAccount = {
  accountId: '111122223333',
  score: 61,
  scannedAt: '2026-11-02T06:00:00.000Z',
  passed: 140,
  failed: 22,
  failedBySeverity: { critical: 2, high: 6, medium: 9, low: 5, informational: 0 },
  history: [
    { date: '2026-11-01', score: 59 },
    { date: '2026-11-02', score: 61 },
  ],
};

const check: PostureCheck = {
  id: 'prowler-aws-iam_root_mfa_enabled-111122223333-us-east-1-root',
  checkId: 'iam_root_mfa_enabled',
  title: 'Usuário root sem MFA',
  severity: 'critical',
  accountId: '111122223333',
  region: 'us-east-1',
  resource: 'arn:aws:iam::111122223333:root',
  resourceType: 'AwsIamUser',
  risk: 'Quem tiver a senha do root controla a conta inteira.',
  remediation: 'Ative o MFA do root no console.',
  references: ['https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-virt-mfa-for-root.html'],
};

describe('postura', () => {
  it('aceita a conta com histórico e a visão do cliente', () => {
    expect(postureAccountSchema.parse(account)).toEqual(account);
    expect(
      postureOverviewSchema.safeParse({ score: 64, warningBelow: 70, accounts: [account] }).success,
    ).toBe(true);
    expect(
      postureAccountSchema.safeParse({ ...account, score: null, scannedAt: null, history: [] }).success,
    ).toBe(true);
  });

  it.each([
    ['nota acima de 100', { score: 101 }],
    ['data do histórico fora do formato', { history: [{ date: '02/11/2026', score: 50 }] }],
    ['severidade a mais', { failedBySeverity: { ...account.failedBySeverity, extra: 1 } }],
  ])('recusa %s', (_name, change) => {
    expect(postureAccountSchema.safeParse({ ...account, ...change }).success).toBe(false);
  });

  it('checagem: referência só HTTPS e ID da checagem do Prowler', () => {
    expect(postureCheckSchema.parse(check)).toEqual(check);
    expect(postureCheckSchema.safeParse({ ...check, references: ['http://exemplo.com'] }).success).toBe(
      false,
    );
    expect(postureCheckSchema.safeParse({ ...check, references: ['javascript:alert(1)'] }).success).toBe(
      false,
    );
    expect(postureCheckSchema.safeParse({ ...check, checkId: 'Root MFA' }).success).toBe(false);
  });

  it('filtros por conta e severidade', () => {
    expect(
      postureCheckListQuerySchema.parse({ severity: 'critical', accountId: '111122223333' }),
    ).toMatchObject({
      severity: 'critical',
      accountId: '111122223333',
      page: 1,
    });
    expect(postureCheckListQuerySchema.safeParse({ severity: 'urgent' }).success).toBe(false);
  });
});
