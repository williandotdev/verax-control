import { describe, expect, it } from 'vitest';
import {
  MAX_POSTURE_ERRORS,
  parsePostureError,
  type PostureAccount,
  postureAccountSchema,
  type PostureCheck,
  postureCheckListQuerySchema,
  postureCheckResultSchema,
  postureCheckSchema,
  postureCheckStatus,
  postureCheckSummarySchema,
  postureErrorValue,
  postureHistoryDays,
  postureOverviewSchema,
  postureSectionErrorSchema,
} from './posture.js';
import { NATIVE_POSTURE_CHECKS, nativePostureCheck } from './posture-catalog.js';

const account: PostureAccount = {
  accountId: '111122223333',
  score: 61,
  scannedAt: '2026-11-02T06:00:00.000Z',
  passed: 140,
  failed: 22,
  unknown: 3,
  failedBySeverity: { critical: 2, high: 6, medium: 9, low: 5, informational: 0 },
  history: [
    { date: '2026-11-01', score: 59 },
    { date: '2026-11-02', score: 61 },
  ],
  checks: [
    {
      checkId: 'guardduty_is_enabled',
      title: 'GuardDuty ligado em cada região monitorada',
      severity: 'high',
      passed: 1,
      failed: 0,
      unknown: 1,
      status: 'unknown',
    },
  ],
  errors: [{ section: 'guardduty', region: 'us-east-1', code: 'AccessDeniedException' }],
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
      postureAccountSchema.safeParse({
        ...account,
        score: null,
        scannedAt: null,
        history: [],
        checks: [],
        errors: [],
        unknown: 0,
      }).success,
    ).toBe(true);
  });

  it('a conta exige as checagens do catálogo, as leituras recusadas e os não lidos (contrato estrito)', () => {
    for (const field of ['checks', 'errors', 'unknown'] as const) {
      const { [field]: _removed, ...rest } = account;
      expect(postureAccountSchema.safeParse(rest).success).toBe(false);
    }
    expect(
      postureAccountSchema.safeParse({ ...account, checks: [{ ...account.checks[0], status: 'talvez' }] })
        .success,
    ).toBe(false);
    expect(
      postureAccountSchema.safeParse({
        ...account,
        errors: Array.from({ length: MAX_POSTURE_ERRORS + 1 }, () => account.errors[0]),
      }).success,
    ).toBe(false);
  });

  it('a evolução segue o histórico do plano, até 365 dias', () => {
    expect(postureHistoryDays(90)).toBe(90);
    expect(postureHistoryDays(365)).toBe(365);
    expect(postureHistoryDays(730)).toBe(365);
    expect(postureHistoryDays(null)).toBe(365);
    const days = Array.from({ length: 366 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 10, 3 + index)).toISOString().slice(0, 10),
      score: 50,
    }));
    expect(postureAccountSchema.safeParse({ ...account, history: days.slice(1) }).success).toBe(true);
    expect(postureAccountSchema.safeParse({ ...account, history: days }).success).toBe(false);
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

  it('a situação de cada checagem: reprovada, não lida (nunca aprovada), aprovada ou não se aplica', () => {
    expect(postureCheckStatus({ passed: 3, failed: 1, unknown: 1 })).toBe('fail');
    expect(postureCheckStatus({ passed: 3, failed: 0, unknown: 1 })).toBe('unknown');
    expect(postureCheckStatus({ passed: 3, failed: 0, unknown: 0 })).toBe('pass');
    expect(postureCheckStatus({ passed: 0, failed: 0, unknown: 0 })).toBe('not_applicable');
    const result = {
      checkId: 'iam_root_mfa_enabled',
      title: 'MFA no root',
      severity: 'critical',
      passed: 1,
      failed: 0,
      unknown: 0,
    };
    expect(postureCheckResultSchema.parse(result)).toEqual(result);
    expect(postureCheckResultSchema.safeParse({ ...result, status: 'pass' }).success).toBe(false);
    expect(postureCheckResultSchema.safeParse({ ...result, passed: -1 }).success).toBe(false);
    expect(postureCheckSummarySchema.parse({ ...result, status: 'pass' })).toMatchObject({ status: 'pass' });
  });

  it('leitura recusada: ida e volta pelo texto gravado, e o fora do formato fica de fora', () => {
    const regional = { section: 'guardduty', region: 'us-east-1', code: 'AccessDeniedException' } as const;
    const global = { section: 's3_account', region: null, code: 'AccessDenied' } as const;
    expect(postureErrorValue(regional)).toBe('guardduty:us-east-1:AccessDeniedException');
    expect(postureErrorValue(global)).toBe('s3_account:AccessDenied');
    expect(parsePostureError('guardduty:us-east-1:AccessDeniedException')).toEqual(regional);
    expect(parsePostureError('s3_account:AccessDenied')).toEqual(global);
    expect(parsePostureError('iam:invalid_items')).toEqual({
      section: 'iam',
      region: null,
      code: 'invalid_items',
    });
    for (const value of [
      'rds:AccessDenied',
      'ebs:lua-1:AccessDenied',
      'iam:Access Denied',
      'iam',
      'a:b:c:d',
      `iam:${'A'.repeat(200)}`,
    ]) {
      expect(parsePostureError(value)).toBeNull();
    }
    expect(postureSectionErrorSchema.safeParse({ ...regional, extra: 1 }).success).toBe(false);
  });

  it('o catálogo nativo: 18 checagens, IDs únicos no formato, títulos e referências HTTPS; correção com o recurso', () => {
    expect(NATIVE_POSTURE_CHECKS).toHaveLength(18);
    expect(new Set(NATIVE_POSTURE_CHECKS.map((item) => item.id)).size).toBe(18);
    for (const item of NATIVE_POSTURE_CHECKS) {
      expect(
        postureCheckResultSchema.safeParse({
          checkId: item.id,
          title: item.title,
          severity: item.severity,
          passed: 0,
          failed: 0,
          unknown: 0,
        }).success,
      ).toBe(true);
      expect(item.failTitle.length).toBeLessThanOrEqual(500);
      expect(item.risk.length).toBeLessThanOrEqual(4000);
      const remediation = item.remediation({
        accountId: '111122223333',
        region: 'sa-east-1',
        resource: 'recurso',
      });
      expect(remediation.length).toBeGreaterThan(0);
      expect(remediation.length).toBeLessThanOrEqual(4000);
      expect(
        postureCheckSchema.safeParse({ ...check, checkId: item.id, references: [...item.references] })
          .success,
      ).toBe(true);
      expect(`${item.title} ${item.failTitle} ${item.risk} ${remediation}`).not.toMatch(/Prowler/);
    }
    expect(
      nativePostureCheck('ec2_instance_imdsv2_enabled')?.remediation({
        accountId: '111122223333',
        region: 'sa-east-1',
        resource: 'i-0abc',
      }),
    ).toContain(
      'aws ec2 modify-instance-metadata-options --region sa-east-1 --instance-id i-0abc --http-tokens required',
    );
    expect(nativePostureCheck('nao_existe')).toBeUndefined();
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
