import { describe, expect, it } from 'vitest';
import {
  ReportRejected,
  parseProwlerReport,
  parseReportKey,
  summarizePosture,
  type PostureCheck,
} from '../../src/posture/prowler-report.js';

const TENANT = '018f2c1e-0000-7000-8000-00000000a1fa';
const ACCOUNT = '111122223333';

/**
 * Um resultado como o Prowler 5.47.0 grava no JSON-OCSF (estrutura de prowler/lib/outputs/ocsf/ocsf.py, campos
 * nulos omitidos). Conta fictícia.
 */
function ocsfFinding(
  overrides: {
    check?: string;
    status?: 'PASS' | 'FAIL' | 'MANUAL';
    severity?: string;
    muted?: boolean;
    account?: string;
    resource?: string;
    region?: string;
  } = {},
): Record<string, unknown> {
  const check = overrides.check ?? 'iam_root_mfa_enabled';
  const region = overrides.region ?? 'us-east-1';
  const account = overrides.account ?? ACCOUNT;
  const resource = overrides.resource ?? `arn:aws:iam::${account}:root`;
  return {
    message: 'Root account has MFA disabled.',
    metadata: {
      event_code: check,
      product: { uid: 'prowler', name: 'Prowler', vendor_name: 'Prowler', version: '5.47.0' },
      profiles: ['cloud', 'datetime'],
      tenant_uid: '',
      version: '1.5.0',
    },
    severity_id: 5,
    severity: overrides.severity ?? 'Critical',
    // Silenciada pela lista de exceções: o Prowler troca o status original por MUTED (mutelist.py).
    status: overrides.muted ? 'Suppressed' : 'New',
    status_code: overrides.muted ? 'MUTED' : (overrides.status ?? 'FAIL'),
    status_detail: 'Root account has MFA disabled.',
    status_id: overrides.muted ? 3 : 1,
    unmapped: { related_url: '', categories: [], compliance: { 'CIS-3.0': ['1.5'] }, scan_id: '0193' },
    activity_name: 'Create',
    activity_id: 1,
    finding_info: {
      created_time: 1793527200,
      created_time_dt: '2026-11-01T06:00:00.000000Z',
      desc: 'Ensure MFA is enabled for the root account.',
      title: 'Ensure MFA is enabled for the root account',
      types: ['Software and Configuration Checks'],
      uid: `prowler-aws-${check}-${account}-${region}-${resource}`,
      name: '<root_account>',
    },
    resources: [
      {
        cloud_partition: 'aws',
        region,
        data: { details: '', metadata: { arn: resource, segredo_do_recurso: 'nunca guardado' } },
        group: { name: 'iam' },
        labels: [],
        name: '<root_account>',
        type: 'Other',
        uid: resource,
      },
    ],
    category_name: 'Findings',
    category_uid: 2,
    class_name: 'Detection Finding',
    class_uid: 2004,
    cloud: {
      account: { name: '', type: 'AWS Account', type_id: 10, uid: account, labels: [] },
      org: { name: '', uid: '' },
      provider: 'aws',
      region,
    },
    remediation: {
      desc: 'Enable MFA for the root account.',
      references: ['https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user_manage_mfa.html'],
    },
    risk_details: 'The root account has unrestricted access.',
    time: 1793527200,
    time_dt: '2026-11-01T06:00:00.000000Z',
    type_uid: 200401,
    type_name: 'Detection Finding: Create',
  };
}

describe('caminho do relatório no bucket (T5.8)', () => {
  it('lê cliente, conta, dia e horário da varredura', () => {
    expect(parseReportKey(`${TENANT}/${ACCOUNT}/2026-11-01/prowler-20261101T060000Z.ocsf.json`)).toEqual({
      tenantId: TENANT,
      accountId: ACCOUNT,
      date: '2026-11-01',
      scannedAt: '2026-11-01T06:00:00.000Z',
    });
  });

  it('recusa caminho fora do padrão, data inexistente ou pasta de outro dia', () => {
    for (const key of [
      `${TENANT}/${ACCOUNT}/2026-11-01/outro.json`,
      `${TENANT}/${ACCOUNT}/2026-02-30/prowler-20260230T060000Z.ocsf.json`,
      `${TENANT}/${ACCOUNT}/2026-11-02/prowler-20261101T060000Z.ocsf.json`,
      `${TENANT}/1111/2026-11-01/prowler-20261101T060000Z.ocsf.json`,
      `../${ACCOUNT}/2026-11-01/prowler-20261101T060000Z.ocsf.json`,
      `${TENANT}/${ACCOUNT}/x/2026-11-01/prowler-20261101T060000Z.ocsf.json`,
    ]) {
      expect(parseReportKey(key)).toBeNull();
    }
  });
});

describe('relatório OCSF do Prowler (T5.8)', () => {
  it('lê só os campos usados, sem os metadados do recurso', () => {
    const { checks, rejected } = parseProwlerReport([ocsfFinding()], { accountId: ACCOUNT });
    expect(rejected).toBe(0);
    expect(checks).toEqual([
      {
        checkId: 'iam_root_mfa_enabled',
        findingUid: `prowler-aws-iam_root_mfa_enabled-${ACCOUNT}-us-east-1-arn:aws:iam::${ACCOUNT}:root`,
        status: 'fail',
        severity: 'critical',
        title: 'Ensure MFA is enabled for the root account',
        region: 'us-east-1',
        resourceUid: `arn:aws:iam::${ACCOUNT}:root`,
        resourceType: 'Other',
        detail: 'Root account has MFA disabled.',
        risk: 'The root account has unrestricted access.',
        remediation: 'Enable MFA for the root account.',
        references: ['https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user_manage_mfa.html'],
      },
    ]);
    expect(JSON.stringify(checks)).not.toContain('nunca guardado');
  });

  it('um resultado de outra conta recusa o relatório inteiro', () => {
    const report = [
      ocsfFinding(),
      ocsfFinding({ check: 's3_bucket_public_access', account: '444455556666' }),
    ];
    expect(() => parseProwlerReport(report, { accountId: ACCOUNT })).toThrow(ReportRejected);
    expect(() => parseProwlerReport(report, { accountId: ACCOUNT })).toThrow(/outra conta/);
  });

  it('itens fora do formato são contados; acima do limite, o relatório é recusado', () => {
    const valid = Array.from({ length: 199 }, (_, n) => ocsfFinding({ check: `check_${n}` }));
    const broken = { ...ocsfFinding({ check: 'quebrado' }), status_code: 'TALVEZ' };
    expect(parseProwlerReport([...valid, broken], { accountId: ACCOUNT }).rejected).toBe(1);
    expect(() => parseProwlerReport([...valid.slice(0, 50), broken, broken], { accountId: ACCOUNT })).toThrow(
      /fora do formato/,
    );
  });

  it('recusa o que não é lista ou passa do limite de resultados', () => {
    expect(() => parseProwlerReport({ findings: [] }, { accountId: ACCOUNT })).toThrow(/não é uma lista/);
    expect(() =>
      parseProwlerReport(
        [ocsfFinding(), ocsfFinding()],
        { accountId: ACCOUNT },
        { maxFindings: 1, maxRejectedRatio: 0 },
      ),
    ).toThrow(/passa de 1/);
    expect(parseProwlerReport([], { accountId: ACCOUNT })).toEqual({ checks: [], rejected: 0 });
  });

  it('checagem silenciada pela lista de exceções (MUTED) fica separada', () => {
    const { checks } = parseProwlerReport([ocsfFinding({ muted: true })], { accountId: ACCOUNT });
    expect(checks[0]?.status).toBe('muted');
  });

  it('resultado repetido conta uma vez', () => {
    const { checks } = parseProwlerReport([ocsfFinding(), ocsfFinding()], { accountId: ACCOUNT });
    expect(checks).toHaveLength(1);
  });
});

describe('nota de postura (T5.8)', () => {
  function check(severity: PostureCheck['severity'], status: PostureCheck['status']): PostureCheck {
    return {
      checkId: 'x',
      findingUid: `${severity}-${status}-${Math.random()}`,
      status,
      severity,
      title: 'x',
      region: 'us-east-1',
      resourceUid: null,
      resourceType: null,
      detail: null,
      risk: null,
      remediation: null,
      references: [],
    };
  }

  it('aprovação ponderada pela severidade: crítica 10, alta 5, média 2, baixa 1', () => {
    // Aprovadas: 1 crítica (10) e 2 baixas (2). Reprovadas: 1 alta (5) e 1 média (2). 12 / 19.
    const summary = summarizePosture([
      check('critical', 'pass'),
      check('low', 'pass'),
      check('low', 'pass'),
      check('high', 'fail'),
      check('medium', 'fail'),
    ]);
    expect(summary).toEqual({
      score: Math.round((12 / 19) * 100),
      passed: 3,
      failed: 2,
      manual: 0,
      muted: 0,
      failedBySeverity: { critical: 0, high: 1, medium: 1, low: 0, informational: 0 },
    });
  });

  it('manuais e silenciadas ficam fora; informativa não pesa; sem peso, sem nota', () => {
    const summary = summarizePosture([
      check('critical', 'muted'),
      check('high', 'manual'),
      check('informational', 'fail'),
      check('medium', 'pass'),
    ]);
    expect(summary).toMatchObject({ score: 100, passed: 1, failed: 1, manual: 1, muted: 1 });
    expect(summarizePosture([check('informational', 'pass')]).score).toBeNull();
    expect(summarizePosture([]).score).toBeNull();
    expect(summarizePosture([check('critical', 'fail')]).score).toBe(0);
  });

  it('do relatório real à nota', () => {
    const { checks } = parseProwlerReport(
      [
        ocsfFinding({ check: 'iam_root_mfa_enabled', status: 'FAIL', severity: 'Critical' }),
        ocsfFinding({ check: 'cloudtrail_multi_region_enabled', status: 'PASS', severity: 'High' }),
        ocsfFinding({ check: 'iam_password_policy_minimum_length_14', status: 'PASS', severity: 'Medium' }),
        ocsfFinding({
          check: 'account_maintain_current_contact_details',
          status: 'MANUAL',
          severity: 'Medium',
        }),
        ocsfFinding({ check: 's3_bucket_public_access', status: 'FAIL', severity: 'Critical', muted: true }),
      ],
      { accountId: ACCOUNT },
    );
    expect(summarizePosture(checks)).toMatchObject({
      score: Math.round((7 / 17) * 100),
      manual: 1,
      muted: 1,
    });
  });
});
