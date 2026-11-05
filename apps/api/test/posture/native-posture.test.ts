import {
  NATIVE_POSTURE_CHECKS,
  parsePostureError,
  type PostureCheckStatus,
  postureCheckResultSchema,
  postureCheckSchema,
  postureCheckStatus,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { AwsConnectionError } from '../../src/aws/web-identity.js';
import type { BucketInfo } from '../../src/inventory/collectors.js';
import {
  collectInventory,
  type AccountInventory,
  InventoryUnavailable,
} from '../../src/inventory/inventory.js';
import { type PostureScanData, toPostureScan } from '../../src/posture/native-posture.js';
import { collectPostureReads, type PostureReads } from '../../src/posture/posture-reads.js';
import { ACCOUNT, DETECTOR_ID, fakeAccount, TRAIL_ARN } from '../inventory/fake-account.js';
import { awsError } from '../inventory/fake-aws.js';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const REGIONS = ['sa-east-1', 'us-east-1'];
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const refuse =
  (name: string, status = 403) =>
  () => {
    throw awsError(name, status);
  };

/** Uma conta em que tudo passa: a base de cada caso, que muda só o que o caso confere. */
function goodInventory(): AccountInventory {
  return {
    accountId: ACCOUNT,
    collectedAt: NOW.toISOString(),
    regions: ['sa-east-1'],
    root: { mfaEnabled: true, accessKeysPresent: false },
    users: [
      {
        userName: 'ana',
        arn: `arn:aws:iam::${ACCOUNT}:user/ana`,
        createdAt: daysAgo(400),
        consoleAccess: true,
        mfaEnabled: true,
        accessKeys: [
          { id: 'AKIAANA0000000000000', status: 'Active', createdAt: daysAgo(10), lastUsedAt: daysAgo(1) },
        ],
      },
    ],
    instances: [
      {
        instanceId: 'i-0aaa1000000000000',
        region: 'sa-east-1',
        state: 'running',
        publicIp: null,
        imdsV2Required: true,
        securityGroupIds: ['sg-0aaa0000000000000'],
      },
    ],
    securityGroups: [
      {
        groupId: 'sg-0aaa0000000000000',
        region: 'sa-east-1',
        name: 'web',
        vpcId: 'vpc-1',
        openToWorld: [{ protocol: 'tcp', fromPort: 443, toPort: 443 }],
      },
    ],
    buckets: [
      {
        name: 'dados',
        region: 'sa-east-1',
        policyPublic: false,
        aclPublic: false,
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
        unreadable: [],
      },
    ],
    truncated: [],
    errors: [],
  };
}

function goodReads(): PostureReads {
  return {
    passwordPolicy: { ok: true, value: { minimumLength: 14, reusePrevention: 24 } },
    accountPublicAccessBlock: {
      ok: true,
      value: {
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: true,
        restrictPublicBuckets: true,
      },
    },
    ebsDefaultEncryption: [{ region: 'sa-east-1', read: { ok: true, value: true } }],
    cloudTrail: { ok: true, value: { loggingTrail: TRAIL_ARN, multiRegionTrails: 1 } },
    guardDuty: [{ region: 'sa-east-1', read: { ok: true, value: 'enabled' } }],
  };
}

const denied = { ok: false, code: 'AccessDenied' } as const;

type Change = (inventory: AccountInventory, reads: PostureReads) => void;

function scanWith(change: Change = () => undefined): PostureScanData {
  const inventory = goodInventory();
  const reads = goodReads();
  change(inventory, reads);
  return toPostureScan(inventory, reads);
}

function statusOf(scan: PostureScanData, checkId: string): PostureCheckStatus {
  const check = scan.checks.find((item) => item.checkId === checkId);
  if (check === undefined) throw new Error(`sem a checagem ${checkId}`);
  return postureCheckStatus(check);
}

const firstBucket = (inventory: AccountInventory) => inventory.buckets[0] as BucketInfo;
const setRule =
  (protocol: string, fromPort: number | null, toPort: number | null): Change =>
  (inventory) => {
    const group = inventory.securityGroups[0];
    if (group) group.openToWorld = [{ protocol, fromPort, toPort }];
  };
const iamRefused: Change = (inventory) => {
  inventory.users = [];
  inventory.errors.push({ section: 'iam', region: null, code: 'AccessDenied' });
};
const rootRefused: Change = (inventory) => {
  inventory.root = null;
  inventory.errors.push({ section: 'root', region: null, code: 'AccessDenied' });
};
const sgRefused: Change = (inventory) => {
  inventory.securityGroups = [];
  inventory.errors.push({ section: 'sg', region: 'sa-east-1', code: 'UnauthorizedOperation' });
};
/** O bucket sem bloqueio configurado e a conta sem o bloqueio dela: só a política e a ACL decidem. */
const noBlocks: Change = (inventory, reads) => {
  firstBucket(inventory).publicAccessBlock = null;
  reads.accountPublicAccessBlock = { ok: true, value: null };
};

/** Para cada checagem do catálogo: o que a reprova e o que a deixa não lida (uma leitura recusada). */
const CASES: Record<string, { fail: Change; unknown: Change }> = {
  iam_root_mfa_enabled: {
    fail: (inventory) => {
      inventory.root = { mfaEnabled: false, accessKeysPresent: false };
    },
    unknown: rootRefused,
  },
  iam_no_root_access_key: {
    fail: (inventory) => {
      inventory.root = { mfaEnabled: true, accessKeysPresent: true };
    },
    unknown: rootRefused,
  },
  iam_user_mfa_enabled_console_access: {
    fail: (inventory) => {
      const [user] = inventory.users;
      if (user) user.mfaEnabled = false;
    },
    unknown: iamRefused,
  },
  iam_rotate_access_key_90_days: {
    fail: (inventory) => {
      const key = inventory.users[0]?.accessKeys[0];
      if (key) key.createdAt = daysAgo(91);
    },
    unknown: iamRefused,
  },
  iam_user_accesskey_unused: {
    fail: (inventory) => {
      const key = inventory.users[0]?.accessKeys[0];
      if (key) key.lastUsedAt = daysAgo(91);
    },
    unknown: iamRefused,
  },
  iam_password_policy_minimum_length_14: {
    fail: (_inventory, reads) => {
      reads.passwordPolicy = { ok: true, value: { minimumLength: 13, reusePrevention: 24 } };
    },
    unknown: (_inventory, reads) => {
      reads.passwordPolicy = denied;
    },
  },
  iam_password_policy_reuse_24: {
    fail: (_inventory, reads) => {
      reads.passwordPolicy = { ok: true, value: { minimumLength: 14, reusePrevention: 23 } };
    },
    unknown: (_inventory, reads) => {
      reads.passwordPolicy = denied;
    },
  },
  ec2_securitygroup_allow_ingress_from_internet_to_all_ports: {
    fail: setRule('-1', null, null),
    unknown: sgRefused,
  },
  ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22: {
    fail: setRule('tcp', 20, 25),
    unknown: sgRefused,
  },
  ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_3389: {
    fail: setRule('6', 3389, 3389),
    unknown: sgRefused,
  },
  ec2_securitygroup_allow_ingress_from_internet_to_database_ports: {
    fail: setRule('tcp', 5432, 5432),
    unknown: sgRefused,
  },
  ec2_instance_imdsv2_enabled: {
    fail: (inventory) => {
      const [instance] = inventory.instances;
      if (instance) instance.imdsV2Required = false;
    },
    unknown: (inventory) => {
      inventory.instances = [];
      inventory.errors.push({ section: 'ec2', region: 'sa-east-1', code: 'UnauthorizedOperation' });
    },
  },
  ec2_ebs_default_encryption: {
    fail: (_inventory, reads) => {
      reads.ebsDefaultEncryption = [{ region: 'sa-east-1', read: { ok: true, value: false } }];
    },
    unknown: (_inventory, reads) => {
      reads.ebsDefaultEncryption = [
        { region: 'sa-east-1', read: { ok: false, code: 'UnauthorizedOperation' } },
      ];
    },
  },
  s3_bucket_public_access: {
    fail: (inventory, reads) => {
      noBlocks(inventory, reads);
      firstBucket(inventory).policyPublic = true;
    },
    // A ACL não pôde ser lida, e nenhum bloqueio lido a ignoraria: pode ser pública.
    unknown: (inventory, reads) => {
      const bucket = firstBucket(inventory);
      bucket.publicAccessBlock = null;
      bucket.aclPublic = null;
      bucket.unreadable = ['GetBucketAcl: AccessDenied'];
      inventory.errors.push({ section: 's3', region: null, code: 'AccessDenied' });
      reads.accountPublicAccessBlock = denied;
    },
  },
  s3_bucket_level_public_access_block: {
    fail: noBlocks,
    unknown: (inventory, reads) => {
      const bucket = firstBucket(inventory);
      bucket.publicAccessBlock = null;
      bucket.unreadable = ['GetPublicAccessBlock: AccessDenied'];
      inventory.errors.push({ section: 's3', region: null, code: 'AccessDenied' });
      reads.accountPublicAccessBlock = denied;
    },
  },
  s3_account_level_public_access_blocks: {
    fail: (_inventory, reads) => {
      reads.accountPublicAccessBlock = { ok: true, value: null };
    },
    unknown: (_inventory, reads) => {
      reads.accountPublicAccessBlock = denied;
    },
  },
  cloudtrail_multi_region_enabled: {
    fail: (_inventory, reads) => {
      reads.cloudTrail = { ok: true, value: { loggingTrail: null, multiRegionTrails: 1 } };
    },
    unknown: (_inventory, reads) => {
      reads.cloudTrail = { ok: false, code: 'TrailNotFoundException' };
    },
  },
  guardduty_is_enabled: {
    fail: (_inventory, reads) => {
      reads.guardDuty = [{ region: 'sa-east-1', read: { ok: true, value: 'suspended' } }];
    },
    unknown: (_inventory, reads) => {
      reads.guardDuty = [{ region: 'sa-east-1', read: { ok: false, code: 'AccessDeniedException' } }];
    },
  },
};

describe('postura nativa da AWS: o catálogo (PR-15)', () => {
  it('18 checagens, com ID no formato do Prowler, texto em português e referência só em HTTPS', () => {
    expect(NATIVE_POSTURE_CHECKS).toHaveLength(18);
    expect(new Set(NATIVE_POSTURE_CHECKS.map((check) => check.id)).size).toBe(18);
    expect(Object.keys(CASES).sort()).toEqual(NATIVE_POSTURE_CHECKS.map((check) => check.id).sort());
    for (const check of NATIVE_POSTURE_CHECKS) {
      expect(check.id).toMatch(/^[a-z0-9_]{1,160}$/);
      expect(check.title).not.toMatch(/Prowler/);
      expect(check.references.length).toBeGreaterThan(0);
      for (const reference of check.references) expect(new URL(reference).protocol).toBe('https:');
    }
  });

  it('a conta em que tudo passa: cada checagem aprovada, nota 100, sem reprovação nem leitura recusada', () => {
    const scan = scanWith();
    for (const check of NATIVE_POSTURE_CHECKS) expect(statusOf(scan, check.id)).toBe('pass');
    expect(scan.summary).toMatchObject({ score: 100, failed: 0, manual: 0 });
    expect(scan.failures).toEqual([]);
    expect(scan.errors).toEqual([]);
    expect(scan.dropped).toBe(0);
  });

  describe.each(NATIVE_POSTURE_CHECKS.map((check) => [check.id, check] as const))('%s', (id, check) => {
    const cases = CASES[id] as { fail: Change; unknown: Change };

    it('reprovada: a reprovação com o título, a severidade, o porquê e o passo de correção', () => {
      const scan = scanWith(cases.fail);
      expect(statusOf(scan, id)).toBe('fail');
      const failure = scan.failures.find((item) => item.checkId === id);
      expect(failure).toMatchObject({
        title: check.failTitle,
        severity: check.severity,
        risk: check.risk,
        references: check.references,
      });
      expect(failure?.remediation).toBeTruthy();
      // A reprovação cabe no contrato da lista (o que a API devolve, com o ID da linha e a conta).
      const { findingUid, ...shown } = failure ?? ({} as never);
      expect(findingUid.startsWith(`${id}:`)).toBe(true);
      expect(postureCheckSchema.safeParse({ ...shown, id: 'linha', accountId: ACCOUNT }).success).toBe(true);
    });

    it('não lida: a leitura recusada não reprova nem aprova, fica fora da nota e marca a varredura', () => {
      const scan = scanWith(cases.unknown);
      expect(statusOf(scan, id)).toBe('unknown');
      expect(scan.failures.filter((item) => item.checkId === id)).toEqual([]);
      const result = scan.checks.find((item) => item.checkId === id);
      expect(result).toMatchObject({ passed: 0, failed: 0 });
      expect(result?.unknown).toBeGreaterThan(0);
      expect(scan.summary.manual).toBeGreaterThan(0);
      expect(scan.errors.length).toBeGreaterThan(0);
      for (const error of scan.errors) expect(parsePostureError(error)).not.toBeNull();
      // Fora da nota: a mesma conta sem a checagem não lida tem a mesma soma de pesos.
      const good = scanWith();
      const weight = { critical: 10, high: 5, medium: 2, low: 1, informational: 0 }[check.severity];
      const goodCount = good.checks.find((item) => item.checkId === id)?.passed ?? 0;
      expect(scan.summary.weightTotal).toBeLessThanOrEqual(good.summary.weightTotal - weight * goodCount);
    });
  });

  it('não se aplica: sem usuário com console, sem chave ativa, sem instância, sem grupo, sem bucket, sem região', () => {
    const scan = scanWith((inventory, reads) => {
      inventory.regions = [];
      inventory.users = [
        {
          ...(inventory.users[0] as AccountInventory['users'][number]),
          consoleAccess: false,
          accessKeys: [],
        },
      ];
      inventory.instances = [];
      inventory.securityGroups = [];
      inventory.buckets = [];
      reads.ebsDefaultEncryption = [];
      reads.guardDuty = [];
    });
    for (const id of [
      'iam_user_mfa_enabled_console_access',
      'iam_rotate_access_key_90_days',
      'iam_user_accesskey_unused',
      'ec2_securitygroup_allow_ingress_from_internet_to_all_ports',
      'ec2_instance_imdsv2_enabled',
      'ec2_ebs_default_encryption',
      's3_bucket_public_access',
      's3_bucket_level_public_access_block',
      'guardduty_is_enabled',
    ]) {
      expect(statusOf(scan, id)).toBe('not_applicable');
    }
    // As da conta continuam valendo.
    expect(statusOf(scan, 'iam_root_mfa_enabled')).toBe('pass');
    expect(statusOf(scan, 's3_account_level_public_access_blocks')).toBe('pass');
  });

  it('a instância encerrada e a chave inativa ficam de fora', () => {
    const scan = scanWith((inventory) => {
      const [instance] = inventory.instances;
      if (instance) Object.assign(instance, { state: 'terminated', imdsV2Required: false });
      const key = inventory.users[0]?.accessKeys[0];
      if (key) Object.assign(key, { status: 'Inactive', createdAt: daysAgo(400), lastUsedAt: daysAgo(400) });
    });
    expect(statusOf(scan, 'ec2_instance_imdsv2_enabled')).toBe('not_applicable');
    expect(statusOf(scan, 'iam_rotate_access_key_90_days')).toBe('not_applicable');
    expect(statusOf(scan, 'iam_user_accesskey_unused')).toBe('not_applicable');
  });

  it('chave nova nunca usada não é "sem uso"; sem uso conta da criação', () => {
    const fresh = scanWith((inventory) => {
      const key = inventory.users[0]?.accessKeys[0];
      if (key) Object.assign(key, { createdAt: daysAgo(30), lastUsedAt: null });
    });
    expect(statusOf(fresh, 'iam_user_accesskey_unused')).toBe('pass');
    const stale = scanWith((inventory) => {
      const key = inventory.users[0]?.accessKeys[0];
      if (key) Object.assign(key, { createdAt: daysAgo(120), lastUsedAt: null });
    });
    expect(statusOf(stale, 'iam_user_accesskey_unused')).toBe('fail');
  });

  it('security groups: UDP 22 não é SSH, ICMP não é "todas as portas", TCP 0-65535 é', () => {
    expect(
      statusOf(
        scanWith(setRule('udp', 22, 22)),
        'ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22',
      ),
    ).toBe('pass');
    expect(
      statusOf(
        scanWith(setRule('icmp', -1, -1)),
        'ec2_securitygroup_allow_ingress_from_internet_to_all_ports',
      ),
    ).toBe('pass');
    const wide = scanWith(setRule('tcp', 0, 65535));
    for (const id of [
      'ec2_securitygroup_allow_ingress_from_internet_to_all_ports',
      'ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22',
      'ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_3389',
      'ec2_securitygroup_allow_ingress_from_internet_to_database_ports',
    ]) {
      expect(statusOf(wide, id)).toBe('fail');
    }
  });

  it('S3: o bloqueio da conta protege o bucket público e sem bloqueio próprio; um bloqueio lido decide sem a ACL', () => {
    const covered = scanWith((inventory, reads) => {
      noBlocks(inventory, reads);
      firstBucket(inventory).policyPublic = true;
      firstBucket(inventory).aclPublic = true;
      reads.accountPublicAccessBlock = {
        ok: true,
        value: {
          blockPublicAcls: false,
          ignorePublicAcls: true,
          blockPublicPolicy: false,
          restrictPublicBuckets: true,
        },
      };
    });
    expect(statusOf(covered, 's3_bucket_public_access')).toBe('pass');
    expect(statusOf(covered, 's3_bucket_level_public_access_block')).toBe('pass');
    expect(statusOf(covered, 's3_account_level_public_access_blocks')).toBe('pass');
    // A ACL não lida, mas o bloqueio do bucket ignora ACLs: o bucket não é público por ela.
    const decided = scanWith((inventory) => {
      const bucket = firstBucket(inventory);
      bucket.aclPublic = null;
      bucket.unreadable = ['GetBucketAcl: AccessDenied'];
    });
    expect(statusOf(decided, 's3_bucket_public_access')).toBe('pass');
    // Público pela ACL, sem bloqueio nenhum.
    const byAcl = scanWith((inventory, reads) => {
      noBlocks(inventory, reads);
      firstBucket(inventory).aclPublic = true;
    });
    expect(statusOf(byAcl, 's3_bucket_public_access')).toBe('fail');
    // A listagem dos buckets recusada: as duas checagens dos buckets não lidas, a da conta continua.
    const listing = scanWith((inventory) => {
      inventory.buckets = [];
      inventory.errors.push({ section: 's3', region: null, code: 'AccessDenied' });
    });
    expect(statusOf(listing, 's3_bucket_public_access')).toBe('unknown');
    expect(statusOf(listing, 's3_bucket_level_public_access_block')).toBe('unknown');
    expect(statusOf(listing, 's3_account_level_public_access_blocks')).toBe('pass');
  });

  it('a varredura parcial: uma região recusada fica não lida, a outra continua valendo', () => {
    const scan = scanWith((inventory, reads) => {
      inventory.regions = ['sa-east-1', 'us-east-1'];
      inventory.errors.push(
        { section: 'ec2', region: 'us-east-1', code: 'UnauthorizedOperation' },
        { section: 'sg', region: 'us-east-1', code: 'UnauthorizedOperation' },
      );
      reads.guardDuty.push({ region: 'us-east-1', read: { ok: false, code: 'AccessDeniedException' } });
      reads.ebsDefaultEncryption.push({ region: 'us-east-1', read: { ok: true, value: false } });
    });
    expect(scan.checks.find((item) => item.checkId === 'ec2_instance_imdsv2_enabled')).toMatchObject({
      passed: 1,
      failed: 0,
      unknown: 1,
    });
    // Uma região aprovada e outra não lida: não lida (nunca aprovada pelo que não foi visto).
    expect(statusOf(scan, 'guardduty_is_enabled')).toBe('unknown');
    expect(statusOf(scan, 'ec2_ebs_default_encryption')).toBe('fail');
    expect(scan.errors).toEqual([
      'ec2:us-east-1:UnauthorizedOperation',
      'sg:us-east-1:UnauthorizedOperation',
      'guardduty:us-east-1:AccessDeniedException',
    ]);
  });

  it('cada resultado fica fora se sair do formato: contado e marcado como itens fora do formato', () => {
    const scan = scanWith((inventory) => {
      const [user] = inventory.users;
      // A chave estável da reprovação passaria de 512 caracteres (a da chave de acesso usa o ID, e fica).
      if (user) user.userName = 'x'.repeat(600);
    });
    expect(scan.dropped).toBe(1);
    expect(scan.errors).toEqual(['iam:invalid_items']);
    expect(scan.checks.find((item) => item.checkId === 'iam_user_mfa_enabled_console_access')).toMatchObject({
      passed: 0,
      failed: 0,
      unknown: 0,
    });
  });
});

describe('postura nativa da AWS: a conta fictícia de ponta a ponta (PR-15)', () => {
  async function collect(options: Parameters<typeof fakeAccount>[0] = {}) {
    const account = fakeAccount(options);
    const target = { accountId: ACCOUNT, regions: REGIONS };
    const inventory = await collectInventory(target, account.clients, { now: NOW });
    const before = account.calls().length;
    const reads = await collectPostureReads(target, account.clients);
    return { inventory, reads, postureCalls: account.calls().slice(before) };
  }

  it('as leituras da postura: poucas, só List, Get e Describe, cada uma no cliente e na região certos', async () => {
    const { reads, postureCalls } = await collect();
    expect(
      postureCalls.map(({ service, region, command, input }) => ({ service, region, command, input })),
    ).toEqual([
      { service: 'iam', region: null, command: 'GetAccountPasswordPolicyCommand', input: {} },
      {
        service: 's3control',
        region: null,
        command: 'GetPublicAccessBlockCommand',
        input: { AccountId: ACCOUNT },
      },
      { service: 'ec2', region: 'sa-east-1', command: 'GetEbsEncryptionByDefaultCommand', input: {} },
      { service: 'guardduty', region: 'sa-east-1', command: 'ListDetectorsCommand', input: {} },
      {
        service: 'guardduty',
        region: 'sa-east-1',
        command: 'GetDetectorCommand',
        input: { DetectorId: DETECTOR_ID },
      },
      { service: 'ec2', region: 'us-east-1', command: 'GetEbsEncryptionByDefaultCommand', input: {} },
      { service: 'guardduty', region: 'us-east-1', command: 'ListDetectorsCommand', input: {} },
      {
        service: 'cloudtrail',
        region: 'sa-east-1',
        command: 'DescribeTrailsCommand',
        input: { includeShadowTrails: true },
      },
      {
        service: 'cloudtrail',
        region: 'sa-east-1',
        command: 'GetTrailStatusCommand',
        input: { Name: TRAIL_ARN },
      },
    ]);
    for (const call of postureCalls) expect(call.command).toMatch(/^(List|Get|Describe)/);
    expect(reads).toEqual({
      passwordPolicy: { ok: true, value: { minimumLength: 8, reusePrevention: 24 } },
      accountPublicAccessBlock: { ok: true, value: null },
      ebsDefaultEncryption: [
        { region: 'sa-east-1', read: { ok: true, value: true } },
        { region: 'us-east-1', read: { ok: true, value: false } },
      ],
      cloudTrail: { ok: true, value: { loggingTrail: TRAIL_ARN, multiRegionTrails: 1 } },
      guardDuty: [
        { region: 'sa-east-1', read: { ok: true, value: 'enabled' } },
        { region: 'us-east-1', read: { ok: true, value: 'missing' } },
      ],
    });
  });

  it('a nota da conta fictícia pela fórmula de sempre (crítica 10, alta 5, média 2, baixa 1)', async () => {
    const { inventory, reads } = await collect();
    const scan = toPostureScan(inventory, reads);
    // Aprovados: 84 de peso (sem uso 2, reúso 2, todas as portas 2×10, RDP 2×5, banco 2×5, IMDSv2 2×5, EBS 5,
    // bucket público 10, bloqueio do bucket 5, trilha 5, GuardDuty 5); reprovados: 94.
    expect(scan.summary).toEqual({
      score: 47,
      weightPassed: 84,
      weightTotal: 178,
      passed: 15,
      failed: 16,
      manual: 0,
      muted: 0,
      failedBySeverity: { critical: 4, high: 10, medium: 2, low: 0, informational: 0 },
    });
    expect(scan.scannedAt).toEqual(NOW);
    expect(scan.errors).toEqual([]);
    expect(scan.checks.map((check) => [check.checkId, postureCheckStatus(check)])).toEqual([
      ['iam_root_mfa_enabled', 'fail'],
      ['iam_no_root_access_key', 'fail'],
      ['iam_user_mfa_enabled_console_access', 'fail'],
      ['iam_rotate_access_key_90_days', 'fail'],
      ['iam_user_accesskey_unused', 'pass'],
      ['iam_password_policy_minimum_length_14', 'fail'],
      ['iam_password_policy_reuse_24', 'pass'],
      ['ec2_securitygroup_allow_ingress_from_internet_to_all_ports', 'pass'],
      ['ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22', 'fail'],
      ['ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_3389', 'pass'],
      ['ec2_securitygroup_allow_ingress_from_internet_to_database_ports', 'pass'],
      ['ec2_instance_imdsv2_enabled', 'fail'],
      ['ec2_ebs_default_encryption', 'fail'],
      ['s3_bucket_public_access', 'fail'],
      ['s3_bucket_level_public_access_block', 'fail'],
      ['s3_account_level_public_access_blocks', 'fail'],
      ['cloudtrail_multi_region_enabled', 'pass'],
      ['guardduty_is_enabled', 'fail'],
    ]);
    for (const check of scan.checks) expect(postureCheckResultSchema.parse(check)).toEqual(check);
    // A nota é a mesma do `summarizePosture` sobre os resultados (a fórmula não mudou).
    expect(scan.failures).toHaveLength(16);
    // Cada reprovação tem a chave estável (a checagem, a região e o recurso) e o recurso na tela.
    expect(
      scan.failures.find((item) => item.checkId === 's3_bucket_public_access' && item.resource === 'dados'),
    ).toMatchObject({
      findingUid: 's3_bucket_public_access:us-east-1:bucket:dados',
      region: 'us-east-1',
      title: 'Bucket S3 público',
      severity: 'critical',
    });
    expect(
      scan.failures.find((item) => item.checkId === 's3_bucket_public_access' && item.resource === 'dados')
        ?.remediation,
    ).toContain('aws s3api put-public-access-block --bucket dados ');
    expect(scan.failures.find((item) => item.checkId === 'iam_rotate_access_key_90_days')).toMatchObject({
      findingUid: 'iam_rotate_access_key_90_days:global:key:AKIABOT0000000000000',
      resource: 'bot · AKIABOT0000000000000',
    });
    expect(scan.failures.filter((item) => item.checkId === 'guardduty_is_enabled')).toMatchObject([
      { region: 'us-east-1', title: 'GuardDuty desligado na região' },
    ]);
    expect(new Set(scan.failures.map((item) => item.findingUid)).size).toBe(16);
    // A mesma coleta dá a mesma varredura (as chaves não dependem de ordem nem de sorteio).
    expect(toPostureScan(inventory, reads)).toEqual(scan);
  });

  it('leituras recusadas viram "não lidas" com o código, e a coleta continua', async () => {
    const { inventory, reads, postureCalls } = await collect({
      iam: { GetAccountPasswordPolicyCommand: refuse('AccessDenied') },
      s3control: { GetPublicAccessBlockCommand: refuse('AccessDenied') },
      ec2: { 'us-east-1': { GetEbsEncryptionByDefaultCommand: refuse('AuthFailure', 401) } },
      guardduty: { 'us-east-1': { ListDetectorsCommand: refuse('AccessDeniedException') } },
      cloudtrail: { DescribeTrailsCommand: refuse('AccessDeniedException') },
    });
    expect(reads.passwordPolicy).toEqual({ ok: false, code: 'AccessDenied' });
    expect(reads.accountPublicAccessBlock).toEqual({ ok: false, code: 'AccessDenied' });
    expect(reads.ebsDefaultEncryption[1]).toEqual({
      region: 'us-east-1',
      read: { ok: false, code: 'AuthFailure' },
    });
    expect(reads.guardDuty[1]).toEqual({
      region: 'us-east-1',
      read: { ok: false, code: 'AccessDeniedException' },
    });
    expect(reads.cloudTrail).toEqual({ ok: false, code: 'AccessDeniedException' });
    // Nenhuma chamada a mais por causa da recusa (o status da trilha não é pedido sem a lista).
    expect(postureCalls.map((call) => call.command)).not.toContain('GetTrailStatusCommand');
    const scan = toPostureScan(inventory, reads);
    expect(scan.errors).toEqual([
      'password_policy:AccessDenied',
      's3_account:AccessDenied',
      'ebs:us-east-1:AuthFailure',
      'guardduty:us-east-1:AccessDeniedException',
      'cloudtrail:AccessDeniedException',
    ]);
    for (const id of [
      'iam_password_policy_minimum_length_14',
      'iam_password_policy_reuse_24',
      's3_account_level_public_access_blocks',
      'cloudtrail_multi_region_enabled',
    ]) {
      expect(statusOf(scan, id)).toBe('unknown');
    }
    // Os buckets sem bloqueio próprio: o bloqueio da conta, não lido, poderia protegê-los (ou restringir a política e
    // ignorar a ACL públicas), então ficam não lidos; o `restrito`, com o bloqueio dele, continua aprovado.
    expect(statusOf(scan, 's3_bucket_public_access')).toBe('unknown');
    expect(statusOf(scan, 's3_bucket_level_public_access_block')).toBe('unknown');
    expect(scan.checks.find((item) => item.checkId === 's3_bucket_public_access')).toMatchObject({
      passed: 1,
      failed: 0,
      unknown: 2,
    });
    expect(scan.summary.manual).toBeGreaterThan(0);
    // Nada da mensagem da AWS no que vai para o banco.
    expect(JSON.stringify(scan)).not.toContain('detalhe-interno');
  });

  it('a trilha: sem multirregião, parada, com o estado recusado, e a da organização recusada com outra gravando', async () => {
    const trails = (...list: object[]) => ({ DescribeTrailsCommand: () => ({ trailList: list }) });
    const multi = (name: string, region = 'sa-east-1') => ({
      TrailARN: `arn:aws:cloudtrail:${region}:${ACCOUNT}:trail/${name}`,
      HomeRegion: region,
      IsMultiRegionTrail: true,
    });
    const none = await collect({ cloudtrail: trails({ ...multi('so-aqui'), IsMultiRegionTrail: false }) });
    expect(none.reads.cloudTrail).toEqual({ ok: true, value: { loggingTrail: null, multiRegionTrails: 0 } });
    expect(none.postureCalls.map((call) => call.command)).not.toContain('GetTrailStatusCommand');

    const stopped = await collect({
      cloudtrail: { ...trails(multi('parada')), GetTrailStatusCommand: () => ({ IsLogging: false }) },
    });
    expect(stopped.reads.cloudTrail).toEqual({
      ok: true,
      value: { loggingTrail: null, multiRegionTrails: 1 },
    });

    const refused = await collect({
      cloudtrail: {
        ...trails(multi('da-organizacao')),
        GetTrailStatusCommand: refuse('TrailNotFoundException', 400),
      },
    });
    expect(refused.reads.cloudTrail).toEqual({ ok: false, code: 'TrailNotFoundException' });

    const other = await collect({
      cloudtrail: {
        ...trails(multi('da-organizacao', 'us-east-1'), multi('propria')),
        GetTrailStatusCommand: (input) => {
          if (String(input['Name']).endsWith('/da-organizacao')) throw awsError('AccessDeniedException', 400);
          return { IsLogging: true };
        },
      },
    });
    expect(other.reads.cloudTrail).toEqual({
      ok: true,
      value: { loggingTrail: `arn:aws:cloudtrail:sa-east-1:${ACCOUNT}:trail/propria`, multiRegionTrails: 2 },
    });
    // O estado de cada trilha pela região de origem dela.
    expect(
      other.postureCalls
        .filter((call) => call.command === 'GetTrailStatusCommand')
        .map((call) => call.region),
    ).toEqual(['us-east-1', 'sa-east-1']);
  });

  it('o GuardDuty suspenso reprova; a resposta fora do formato fica não lida', async () => {
    const { reads } = await collect({
      guardduty: {
        'sa-east-1': { GetDetectorCommand: () => ({ Status: 'DISABLED' }) },
        'us-east-1': { ListDetectorsCommand: () => ({ DetectorIds: ['ID COM ESPAÇO'] }) },
      },
    });
    expect(reads.guardDuty).toEqual([
      { region: 'sa-east-1', read: { ok: true, value: 'suspended' } },
      { region: 'us-east-1', read: { ok: false, code: 'invalid_items' } },
    ]);
  });

  it('falha passageira, sessão perdida e cancelamento param a coleta inteira (nada vira "não lida")', async () => {
    for (const [name, status] of [
      ['ThrottlingException', 400],
      ['ServiceUnavailable', 503],
      ['InternalError', 500],
    ] as const) {
      await expect(collect({ cloudtrail: { GetTrailStatusCommand: refuse(name, status) } })).rejects.toEqual(
        new InventoryUnavailable('aws_unavailable'),
      );
    }
    await expect(
      collect({
        s3control: {
          GetPublicAccessBlockCommand: () => {
            throw new AwsConnectionError('trust_denied', true);
          },
        },
      }),
    ).rejects.toBeInstanceOf(AwsConnectionError);

    const account = fakeAccount();
    const controller = new AbortController();
    controller.abort(new Error('parada do worker'));
    const reads = collectPostureReads(
      { accountId: ACCOUNT, regions: REGIONS },
      {
        ...account.clients,
        iam: () =>
          ({
            send: () => Promise.reject(awsError('AccessDenied', 403)),
          }) as never,
      },
      { signal: controller.signal },
    );
    await expect(reads).rejects.toThrow('parada do worker');
  });

  it('a conta sem política de senha reprova as duas checagens de senha (vale a padrão da AWS)', async () => {
    const { inventory, reads } = await collect({
      iam: { GetAccountPasswordPolicyCommand: refuse('NoSuchEntityException', 404) },
    });
    expect(reads.passwordPolicy).toEqual({ ok: true, value: null });
    const scan = toPostureScan(inventory, reads);
    expect(statusOf(scan, 'iam_password_policy_minimum_length_14')).toBe('fail');
    expect(statusOf(scan, 'iam_password_policy_reuse_24')).toBe('fail');
  });
});
