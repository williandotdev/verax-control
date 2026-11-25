import { createHash } from 'node:crypto';
import { FINDING_SEVERITIES, FINDING_SOURCES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  boundedCaseGroup,
  CASE_FAMILIES,
  CASE_GROUP_MAX,
  CASE_KEY_VERSION,
  type CaseFold,
  type CaseKeyInput,
  caseKeyOf,
  foldedCaseKey,
  networkOf,
} from './case-key.js';

const ACCOUNT = '111111111111';
const OTHER_ACCOUNT = '222222222222';

function finding(overrides: Partial<CaseKeyInput> = {}): CaseKeyInput {
  return {
    accountId: ACCOUNT,
    logSource: 'cloudtrail',
    severity: 'high',
    ruleId: '100305',
    title: 'Permissão de administrador concedida',
    eventName: null,
    resource: null,
    actorUser: null,
    sourceIp: null,
    caseGroup: null,
    ...overrides,
  };
}

const key = (overrides: Partial<CaseKeyInput> = {}) => caseKeyOf(finding(overrides));
const keyHash = (overrides: Partial<CaseKeyInput> = {}) => key(overrides).groupKey;

/** A mesma conta da versão 1, refeita aqui só com o formato do desenho: o hash de um array JSON. */
const hashOf = (...parts: unknown[]) =>
  createHash('sha256')
    .update(JSON.stringify(['v1', ...parts]))
    .digest('hex');

// ---------------------------------------------------------------------------------------------------
// Um gerador fixo (mulberry32): as propriedades rodam com as mesmas entradas em toda execução.
// ---------------------------------------------------------------------------------------------------
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(next: () => number, values: readonly T[]): T =>
  values[Math.floor(next() * values.length)] as T;

// Por código, para o arquivo não levar caractere invisível nem que se confunda com outro.
const RIGHT_TO_LEFT = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const REPLACEMENT = String.fromCodePoint(0xfffd);
/** O "é" em dois caracteres (a letra e o acento), e o "a" cirílico e o de largura cheia. */
const DECOMPOSED = `e${String.fromCodePoint(0x301)}`;
const CYRILLIC_ADMIN = `${String.fromCodePoint(0x430)}dmin`;
const FULLWIDTH_ADMIN = `${String.fromCodePoint(0xff41)}dmin`;

/** Os pedaços de que se faz um valor hostil: delimitadores, aspas, escapes, unicode, formatos que as regras procuram. */
const HOSTILE = [
  '"',
  '","',
  '"],["',
  '\\',
  '\\"',
  ',',
  '[',
  ']',
  '|',
  ':',
  '/',
  ' - ',
  ' affects ',
  '\n',
  '\u0001',
  RIGHT_TO_LEFT,
  'é',
  DECOMPOSED,
  '😀',
  '\ud83d',
  'assumed-role/',
  'arn:aws:sts::111111111111:assumed-role/Deploy/',
  'CVE-2026-0001',
  'S3.1',
  'TTPs/',
  '203.0.113.7',
  '2001:db8::1',
  'null',
  'v1',
  'actor',
  'resource',
  'a',
  'b',
  '',
];
function hostile(next: () => number): string {
  let value = '';
  const pieces = Math.floor(next() * 5);
  for (let index = 0; index <= pieces; index += 1) value += pick(next, HOSTILE);
  return value;
}

const RULES = [
  '80202',
  '80254',
  '80255',
  '80302',
  '80303',
  '80443',
  '100305',
  '100400',
  '100401',
  '990102',
  '990330',
  '990333',
  '990501',
  '990502',
  '990511',
  '990512',
  '990513',
  '990521',
  '990522',
  '23505',
  '19007',
  '19111',
  '5763',
  '60204',
  '',
  '999999',
];
const SOURCES = [...FINDING_SOURCES, 'fonte_nova', ''];

function randomFinding(next: () => number): CaseKeyInput {
  const maybe = (): string | null => (next() < 0.3 ? null : hostile(next));
  return {
    accountId: pick(next, [ACCOUNT, OTHER_ACCOUNT, 'agent:001', 'vx-projeto-demo', hostile(next)]),
    logSource: pick(next, SOURCES),
    severity: pick(next, FINDING_SEVERITIES),
    ruleId: pick(next, RULES),
    title: hostile(next),
    eventName: maybe(),
    resource: maybe(),
    actorUser: maybe(),
    sourceIp: next() < 0.5 ? pick(next, ['203.0.113.7', '10.0.0.1', '2001:db8::1', 'lixo']) : null,
    caseGroup: next() < 0.7 ? null : hostile(next),
  };
}

const HASH = /^[0-9a-f]{64}$/;

describe('formato da chave', () => {
  it('é o SHA-256 de um array JSON com a versão, a fila, a família, a faixa, a conta e as partes', () => {
    const actor = 'arn:aws:iam::111111111111:user/maria';
    expect(key({ actorUser: actor })).toEqual({
      version: 1,
      queue: 'detection',
      family: 'cloudtrail',
      tier: 'hc',
      groupKey: hashOf('detection', 'cloudtrail', 'hc', ACCOUNT, ['rule', '100305'], ['actor', actor]),
      parts: [
        { name: 'rule', value: '100305' },
        { name: 'actor', value: actor },
      ],
      group: null,
    });
    expect(CASE_KEY_VERSION).toBe(1);
  });

  // Mudar um destes valores parte todos os casos abertos: só com outra versão da chave.
  it.each<[string, Partial<CaseKeyInput>, unknown[], string]>([
    [
      'cloudtrail, ator',
      { actorUser: 'arn:aws:iam::111111111111:user/maria' },
      [
        'detection',
        'cloudtrail',
        'hc',
        ACCOUNT,
        ['rule', '100305'],
        ['actor', 'arn:aws:iam::111111111111:user/maria'],
      ],
      '44de762c0c75384c50fd88c518fb9bff967ea364ee49d7f39df7ad27d5809d11',
    ],
    [
      'guardduty',
      {
        logSource: 'guardduty',
        ruleId: '80303',
        eventName: 'Recon:EC2/Portscan',
        resource: 'ec2:i-0abc1234',
      },
      [
        'detection',
        'guardduty',
        'hc',
        ACCOUNT,
        ['type', 'Recon:EC2/Portscan'],
        ['resource', 'ec2:i-0abc1234'],
      ],
      '0107bdf06fd36027546c22341479d3260b7c810d7c74859ea01f9f64572e0a8c',
    ],
    [
      'inspector',
      {
        logSource: 'inspector',
        ruleId: '990511',
        eventName: 'CVE-2026-0001',
        caseGroup: 'openssl',
        resource: 'ec2:i-0abc1234',
      },
      ['vulnerability', 'package', 'any', ACCOUNT, ['package', 'openssl'], ['resource', 'ec2:i-0abc1234']],
      '89d7d5026f8da53e384200aa71b01ca2c921aa85d25af8cd7a2be7340e514de8',
    ],
    [
      'security hub, controle',
      { logSource: 'security_hub', ruleId: '990501', eventName: 'S3.1', resource: 's3:bucket-demo' },
      ['posture', 'control', 'hc', ACCOUNT, ['control', 'S3.1']],
      'd157419061fd840c3ea4c98c7a3e767653686e797f4619ead85a7917c911d660',
    ],
    [
      'waf',
      { logSource: 'waf', ruleId: '80443', resource: 'waf:acl-demo', sourceIp: '203.0.113.7' },
      [
        'detection',
        'waf',
        'hc',
        ACCOUNT,
        ['rule', '80443'],
        ['resource', 'waf:acl-demo'],
        ['network', 'ipv4:203.0.113.0/24'],
      ],
      'e165684d49ae2a5e4063c89bd0fd615e21e6b2b031ab10874a3c1adf97f87d66',
    ],
  ])('valor fixo: %s', (_name, overrides, parts, hash) => {
    expect(keyHash(overrides)).toBe(hash);
    expect(hashOf(...parts)).toBe(hash);
  });

  it('a família é sempre uma das conhecidas e cabe na coluna', () => {
    for (const family of CASE_FAMILIES) expect(family.length).toBeLessThanOrEqual(64);
    expect(new Set(CASE_FAMILIES).size).toBe(CASE_FAMILIES.length);
  });

  it('a conta separa; o cliente não entra (a unicidade é por cliente, no banco)', () => {
    expect(keyHash({ actorUser: 'maria' })).not.toBe(
      keyHash({ actorUser: 'maria', accountId: OTHER_ACCOUNT }),
    );
  });
});

describe('filas e famílias por fonte', () => {
  it.each<[string, Partial<CaseKeyInput>, ReturnType<typeof key>['queue'], string]>([
    ['cloudtrail', {}, 'detection', 'cloudtrail'],
    ['login no console com falha', { ruleId: '80254', severity: 'low' }, 'detection', 'console-login'],
    ['força bruta no console', { ruleId: '80255' }, 'detection', 'console-login'],
    ['guardduty', { logSource: 'guardduty', ruleId: '80303' }, 'detection', 'guardduty'],
    ['waf da AWS', { logSource: 'waf', ruleId: '80443' }, 'detection', 'waf'],
    ['waf do Cloudflare', { logSource: 'cloudflare_waf', ruleId: '990330' }, 'detection', 'waf'],
    ['logs do ALB, sondagem', { logSource: 'alb', ruleId: '990402' }, 'detection', 'web'],
    ['logs do ALB, força bruta', { logSource: 'alb', ruleId: '990405' }, 'detection', 'web-login'],
    ['logs do ALB, força bruta distribuída', { logSource: 'alb', ruleId: '990407' }, 'detection', 'web'],
    ['flow logs', { logSource: 'vpc_flow', ruleId: '100401' }, 'detection', 'vpc-flow'],
    ['CloudWatch Logs', { logSource: 'cloudwatch_logs', ruleId: '5763' }, 'detection', 'cloudwatch-logs'],
    ['auditoria da GCP', { logSource: 'gcp_audit', ruleId: '990102' }, 'detection', 'gcp-audit'],
    [
      'auditoria do Cloudflare',
      { logSource: 'cloudflare_audit', ruleId: '990301' },
      'detection',
      'cloudflare-audit',
    ],
    ['agente', { logSource: 'wazuh_agent', ruleId: '550' }, 'detection', 'host'],
    ['agente, login', { logSource: 'wazuh_agent', ruleId: '5763' }, 'detection', 'host-login'],
    ['agente, vulnerabilidade', { logSource: 'wazuh_agent', ruleId: '23505' }, 'vulnerability', 'package'],
    ['agente, SCA', { logSource: 'wazuh_agent', ruleId: '19007' }, 'posture', 'host-configuration'],
    ['inspector, pacote', { logSource: 'inspector', ruleId: '990511' }, 'vulnerability', 'package'],
    ['inspector, rede', { logSource: 'inspector', ruleId: '990512' }, 'posture', 'network-exposure'],
    ['inspector, código', { logSource: 'inspector', ruleId: '990513' }, 'vulnerability', 'code'],
    [
      'controle do Security Hub',
      { logSource: 'security_hub', ruleId: '990501', eventName: 'S3.1' },
      'posture',
      'control',
    ],
    ['Access Analyzer', { logSource: 'access_analyzer', ruleId: '990521' }, 'posture', 'access-analyzer'],
    ['fonte desconhecida', { logSource: 'fonte_nova', ruleId: '999999' }, 'detection', 'other'],
    ['inspector com regra desconhecida', { logSource: 'inspector', ruleId: '990599' }, 'detection', 'other'],
    [
      'security hub com regra desconhecida',
      { logSource: 'security_hub', ruleId: '990599' },
      'detection',
      'other',
    ],
  ])('%s', (_name, overrides, queue, family) => {
    expect(key(overrides)).toMatchObject({ queue, family });
  });

  it.each(['23501', '23502', '23503', '23504', '23505', '23506', '23507', '23508'])(
    'a regra %s do agente é do detector de vulnerabilidades',
    (ruleId) => {
      expect(key({ logSource: 'wazuh_agent', ruleId }).queue).toBe('vulnerability');
    },
  );

  // As vizinhas das faixas: 19111 a 19153 são falhas de login do VMware, que nunca podem cair na fila de postura.
  it.each([
    '23500',
    '23509',
    '2350',
    '235050',
    '18999',
    '19016',
    '19111',
    '19152',
    '19153',
    '1900',
    '190070',
  ])('a regra %s, fora das faixas, é detecção', (ruleId) => {
    expect(key({ logSource: 'wazuh_agent', ruleId }).queue).toBe('detection');
  });

  it('as faixas do Wazuh só valem no agente: a mesma regra noutra fonte é detecção', () => {
    for (const ruleId of ['23505', '19007']) {
      expect(key({ logSource: 'cloudwatch_logs', ruleId }).queue).toBe('detection');
    }
  });
});

describe('detecção: as partes da chave', () => {
  describe('cloudtrail', () => {
    const session = (role: string, name: string, account = ACCOUNT) =>
      `arn:aws:sts::${account}:assumed-role/${role}/${name}`;

    it('a sessão do papel não separa (quem chama escolhe o nome dela); o papel e a conta dele, sim', () => {
      const base = keyHash({ actorUser: session('Deploy', 'sessao-1') });
      for (const name of ['sessao-2', 'a/b/c', 'assumed-role/Outro/x', '"],["actor"', ' ', '😀']) {
        expect(keyHash({ actorUser: session('Deploy', name) }), name).toBe(base);
      }
      expect(keyHash({ actorUser: session('Admin', 'sessao-1') })).not.toBe(base);
      expect(keyHash({ actorUser: session('Deploy', 'sessao-1', OTHER_ACCOUNT) })).not.toBe(base);
    });

    it('o ARN do próprio papel (com caminho) é o mesmo ator que a sessão dele', () => {
      expect(keyHash({ actorUser: `arn:aws:iam::${ACCOUNT}:role/time/Deploy` })).toBe(
        keyHash({ actorUser: session('Deploy', 'x') }),
      );
    });

    it('o nome do usuário federado também é escolhido por quem chama', () => {
      const federated = (name: string) => `arn:aws:sts::${ACCOUNT}:federated-user/${name}`;
      expect(keyHash({ actorUser: federated('ana') })).toBe(keyHash({ actorUser: federated('bia') }));
      expect(keyHash({ actorUser: federated('ana') })).not.toBe(
        keyHash({ actorUser: `arn:aws:sts::${OTHER_ACCOUNT}:federated-user/ana` }),
      );
    });

    it('um nome igual à forma reduzida de outro ator não cai no caso dele', () => {
      const reduced = [
        key({ actorUser: session('Deploy', 'x') }),
        key({ actorUser: `arn:aws:sts::${ACCOUNT}:federated-user/ana` }),
        key({ actorUser: 'AROAEXAMPLEDEMO000001:sessao' }),
      ];
      for (const { groupKey, parts } of reduced) {
        const shown = parts.at(-1)?.value ?? '';
        for (const actorUser of [shown, `role:${shown}`, `federated:${shown}`]) {
          expect(keyHash({ actorUser }), actorUser).not.toBe(groupKey);
        }
      }
    });

    it('usuário IAM, root e nome solto ficam como estão', () => {
      const actors = [
        `arn:aws:iam::${ACCOUNT}:user/maria`,
        `arn:aws:iam::${ACCOUNT}:user/Maria`,
        `arn:aws:iam::${ACCOUNT}:root`,
        'maria',
        'assumed-role/Deploy/x',
      ];
      expect(new Set(actors.map((actorUser) => keyHash({ actorUser }))).size).toBe(actors.length);
    });

    it('sem ator vale o recurso; sem os dois, a regra', () => {
      const byResource = keyHash({ resource: 's3:bucket-demo' });
      expect(byResource).not.toBe(keyHash({ resource: 's3:outro' }));
      expect(byResource).not.toBe(keyHash({ actorUser: 's3:bucket-demo' }));
      expect(keyHash()).toBe(hashOf('detection', 'cloudtrail', 'hc', ACCOUNT, ['rule', '100305']));
      expect(keyHash({ actorUser: 'maria', resource: 's3:a' })).toBe(
        keyHash({ actorUser: 'maria', resource: 's3:b' }),
      );
      expect(keyHash({ actorUser: '   ', resource: 's3:a' })).toBe(keyHash({ resource: 's3:a' }));
    });

    it('a regra separa, e o IP não', () => {
      expect(keyHash({ actorUser: 'maria' })).not.toBe(keyHash({ actorUser: 'maria', ruleId: '100306' }));
      expect(keyHash({ actorUser: 'maria', sourceIp: '203.0.113.7' })).toBe(keyHash({ actorUser: 'maria' }));
    });
  });

  it('login no console: a rede de origem, nunca o usuário (é o que quem ataca digita)', () => {
    const login = (overrides: Partial<CaseKeyInput>) => keyHash({ ruleId: '80255', ...overrides });
    expect(login({ sourceIp: '203.0.113.7', actorUser: 'a' })).toBe(
      login({ sourceIp: '203.0.113.99', actorUser: 'b', resource: 'iam-user:c' }),
    );
    expect(login({ sourceIp: '203.0.113.7' })).not.toBe(login({ sourceIp: '203.0.114.7' }));
    expect(login({ actorUser: 'a' })).toBe(login({ actorUser: 'b' }));
  });

  describe('guardduty', () => {
    const native = { logSource: 'guardduty', ruleId: '80303', title: 'AWS GuardDuty: x.' };
    const copy = {
      logSource: 'security_hub',
      ruleId: '990502',
      title: 'Achado do Security Hub (GuardDuty): x',
    };
    const type = 'UnauthorizedAccess:EC2/SSHBruteForce';

    it('o tipo e o recurso; sem recurso, o ator; o IP remoto e a regra nunca', () => {
      const at = (overrides: Partial<CaseKeyInput>) => keyHash({ ...native, eventName: type, ...overrides });
      const base = at({ resource: 'ec2:i-0abc1234' });
      expect(at({ resource: 'ec2:i-0abc1234', sourceIp: '203.0.113.7', actorUser: 'maria' })).toBe(base);
      expect(at({ resource: 'ec2:i-0abc1234', ruleId: '80307' })).toBe(base);
      expect(at({ resource: 'ec2:i-0def5678' })).not.toBe(base);
      expect(keyHash({ ...native, eventName: 'Recon:EC2/Portscan', resource: 'ec2:i-0abc1234' })).not.toBe(
        base,
      );
      expect(at({ actorUser: 'maria' })).not.toBe(at({ actorUser: 'ana' }));
      expect(at({ actorUser: 'AROAEXAMPLEDEMO000001:sessao-1' })).toBe(
        at({ actorUser: 'AROAEXAMPLEDEMO000001:sessao-2' }),
      );
    });

    it('a cópia do Security Hub cai no mesmo caso do achado do próprio GuardDuty', () => {
      const same = { resource: 'ec2:i-0abc1234' };
      for (const copied of [
        'TTPs/Initial Access/UnauthorizedAccess:EC2-SSHBruteForce',
        'TTPs/UnauthorizedAccess:EC2-SSHBruteForce',
      ]) {
        expect(keyHash({ ...copy, ...same, eventName: copied })).toBe(
          keyHash({ ...native, ...same, eventName: type }),
        );
      }
      expect(
        key({ ...copy, ...same, eventName: 'TTPs/Command and Control/Backdoor:EC2-C&CActivity.B!DNS' })
          .groupKey,
      ).toBe(keyHash({ ...native, ...same, eventName: 'Backdoor:EC2/C&CActivity.B!DNS' }));
    });

    it('a cópia é sempre detecção, mesmo com um tipo de postura', () => {
      expect(
        key({ ...copy, eventName: 'Software and Configuration Checks/Policy:IAMUser-RootCredentialUsage' }),
      ).toMatchObject({ queue: 'detection', family: 'guardduty' });
    });
  });

  it('waf: a regra e a ACL (ou a zona); as regras por IP, também a rede', () => {
    const acl = { logSource: 'waf', ruleId: '80443', resource: 'waf:acl-a' };
    expect(keyHash({ ...acl, sourceIp: '203.0.113.7' })).toBe(keyHash({ ...acl, sourceIp: '203.0.113.8' }));
    expect(keyHash({ ...acl, sourceIp: '203.0.113.7' })).not.toBe(
      keyHash({ ...acl, sourceIp: '198.51.100.7' }),
    );
    expect(keyHash({ ...acl, sourceIp: '203.0.113.7' })).not.toBe(
      keyHash({ ...acl, resource: 'waf:acl-b', sourceIp: '203.0.113.7' }),
    );
    for (const ruleId of ['990330', '990331', '990332', '990335']) {
      const perIp = { logSource: 'cloudflare_waf', ruleId, resource: 'exemplo.com.br' };
      expect(keyHash({ ...perIp, sourceIp: '203.0.113.7' }), ruleId).not.toBe(
        keyHash({ ...perIp, sourceIp: '198.51.100.7' }),
      );
      // O resumo dos IPs além do teto não tem IP: é um caso só por regra e zona.
      expect(keyHash(perIp)).not.toBe(keyHash({ ...perIp, sourceIp: '203.0.113.7' }));
    }
    for (const ruleId of ['990333', '990334']) {
      const perZone = { logSource: 'cloudflare_waf', ruleId, resource: 'exemplo.com.br' };
      expect(keyHash({ ...perZone, sourceIp: '203.0.113.7' }), ruleId).toBe(keyHash(perZone));
      expect(keyHash(perZone)).not.toBe(keyHash({ ...perZone, resource: 'outro.com.br' }));
    }
    // A contagem no nome do evento muda a cada janela e não separa.
    expect(keyHash({ ...acl, eventName: '500 requisições' })).toBe(
      keyHash({ ...acl, eventName: '501 requisições' }),
    );
  });

  it('logs do ALB: a força bruta e o acesso depois das falhas, do mesmo endereço no mesmo balanceador, são um caso só', () => {
    const login = (overrides: Partial<CaseKeyInput>) =>
      keyHash({
        logSource: 'alb',
        ruleId: '990405',
        resource: 'alb:app/loja/0000000000000001',
        sourceIp: '203.0.113.7',
        ...overrides,
      });
    expect(login({})).toBe(login({ ruleId: '990406', severity: 'critical', eventName: 'outro' }));
    expect(login({})).toBe(login({ sourceIp: '203.0.113.99' }));
    expect(login({})).not.toBe(login({ sourceIp: '198.51.100.7' }));
    expect(login({})).not.toBe(login({ resource: 'alb:app/api/0000000000000002' }));
    // Atrás de uma CDN não há endereço: um caso por balanceador.
    expect(login({ sourceIp: null })).toBe(login({ sourceIp: null, ruleId: '990406' }));
    expect(login({ sourceIp: null })).not.toBe(login({}));
    expect(key({ logSource: 'alb', ruleId: '990405', resource: null, sourceIp: null }).parts).toEqual([
      { name: 'rule', value: '990405' },
    ]);
  });

  it('logs do ALB, o resto: a regra, o balanceador e a rede; a força bruta distribuída, sem rede', () => {
    const web = (overrides: Partial<CaseKeyInput>) =>
      keyHash({
        logSource: 'alb',
        ruleId: '990403',
        resource: 'alb:app/loja/0000000000000001',
        sourceIp: '203.0.113.7',
        ...overrides,
      });
    expect(web({})).toBe(web({ sourceIp: '203.0.113.8', eventName: 'GET /backup.zip' }));
    expect(web({})).not.toBe(web({ ruleId: '990402' }));
    expect(web({})).not.toBe(web({ sourceIp: '198.51.100.7' }));
    expect(web({})).not.toBe(web({ resource: 'alb:app/api/0000000000000002' }));
    expect(web({ ruleId: '990407', sourceIp: null })).not.toBe(
      web({ ruleId: '990407', sourceIp: null, resource: 'alb:app/api/0000000000000002' }),
    );
    // A sondagem média, de qualquer endereço, cabe num caso por conta e regra.
    expect(web({ ruleId: '990402', severity: 'medium' })).toBe(
      web({
        ruleId: '990402',
        severity: 'medium',
        sourceIp: '198.51.100.7',
        resource: 'alb:app/api/0000000000000002',
      }),
    );
  });

  it('flow logs: a regra e a rede; a interface não separa', () => {
    const flow = { logSource: 'vpc_flow', ruleId: '100401', sourceIp: '203.0.113.7' };
    expect(keyHash({ ...flow, resource: 'eni:eni-0abc1234' })).toBe(
      keyHash({ ...flow, resource: 'eni:eni-0def5678' }),
    );
    expect(keyHash(flow)).not.toBe(keyHash({ ...flow, ruleId: '100400' }));
    expect(keyHash({ ...flow, sourceIp: '10.0.0.1' })).not.toBe(keyHash({ ...flow, sourceIp: '10.0.0.2' }));
  });

  it('CloudWatch Logs: a regra e a rede; sem IP, o usuário; sem os dois, a regra', () => {
    const line = { logSource: 'cloudwatch_logs', ruleId: '5763' };
    expect(keyHash({ ...line, sourceIp: '203.0.113.7', actorUser: 'a' })).toBe(
      keyHash({ ...line, sourceIp: '203.0.113.8', actorUser: 'b' }),
    );
    expect(keyHash({ ...line, actorUser: 'a' })).not.toBe(keyHash({ ...line, actorUser: 'b' }));
    expect(keyHash(line)).not.toBe(keyHash({ ...line, actorUser: 'a' }));
  });

  it('auditoria da GCP e do Cloudflare: a regra e quem agiu; sem ele, o recurso', () => {
    for (const logSource of ['gcp_audit', 'cloudflare_audit']) {
      const audit = { logSource, ruleId: '990102' };
      expect(keyHash({ ...audit, actorUser: 'a@cliente.example', resource: 'r1' })).toBe(
        keyHash({ ...audit, actorUser: 'a@cliente.example', resource: 'r2' }),
      );
      expect(keyHash({ ...audit, resource: 'r1' })).not.toBe(keyHash({ ...audit, resource: 'r2' }));
    }
  });

  it('agente: a regra e a instância; nas regras de login, também a rede', () => {
    const host = { logSource: 'wazuh_agent', accountId: 'agent:001', resource: 'host:app-1' };
    expect(keyHash({ ...host, ruleId: '550', sourceIp: '203.0.113.7' })).toBe(
      keyHash({ ...host, ruleId: '550' }),
    );
    expect(keyHash({ ...host, ruleId: '5763', sourceIp: '203.0.113.7' })).not.toBe(
      keyHash({ ...host, ruleId: '5763', sourceIp: '198.51.100.7' }),
    );
    expect(keyHash({ ...host, ruleId: '5763', sourceIp: '203.0.113.7', actorUser: 'root' })).toBe(
      keyHash({ ...host, ruleId: '5763', sourceIp: '203.0.113.7', actorUser: 'admin' }),
    );
    expect(keyHash({ ...host, ruleId: '550' })).not.toBe(
      keyHash({ ...host, ruleId: '550', resource: 'host:app-2' }),
    );
  });
});

describe('vulnerabilidade: o pacote e o recurso, literais (decisão D1)', () => {
  const inspector = {
    logSource: 'inspector',
    ruleId: '990511',
    eventName: 'CVE-2026-0001',
    title: 'Vulnerabilidade em pacote: CVE-2026-0001 - openssl',
    resource: 'ec2:i-0abc1234',
  };

  it('outro pacote ou outro recurso é outro caso; outro CVE do mesmo pacote e recurso, não', () => {
    const base = keyHash(inspector);
    expect(key(inspector).group).toBe('openssl');
    expect(
      keyHash({
        ...inspector,
        eventName: 'CVE-2026-0002',
        title: 'Vulnerabilidade em pacote: CVE-2026-0002 - openssl',
      }),
    ).toBe(base);
    expect(keyHash({ ...inspector, caseGroup: 'curl' })).not.toBe(base);
    expect(keyHash({ ...inspector, resource: 'ec2:i-0def5678' })).not.toBe(base);
    expect(keyHash({ ...inspector, accountId: OTHER_ACCOUNT })).not.toBe(base);
  });

  it('a severidade não separa: o mesmo pacote no mesmo recurso é um caso só', () => {
    const keys = FINDING_SEVERITIES.map((severity) => key({ ...inspector, severity }));
    expect(new Set(keys.map((found) => found.groupKey)).size).toBe(1);
    expect(new Set(keys.map((found) => found.tier))).toEqual(new Set(['any']));
  });

  it('o pacote gravado na chegada e o lido do título dão a mesma chave', () => {
    expect(keyHash({ ...inspector, caseGroup: 'openssl' })).toBe(keyHash(inspector));
    expect(keyHash({ ...inspector, caseGroup: 'openssl', title: 'qualquer' })).toBe(keyHash(inspector));
  });

  it.each([
    ['CVE-2026-0001 - openssl', 'openssl'],
    ['CVE-2026-0001 - openssl, openssl-libs', 'openssl'],
    ['CVE-2026-0001 - openssl, openssl-libs and 3 more', 'openssl'],
    ['CVE-2026-0001 - openssl and 3 more', 'openssl'],
    ['CVE-2026-0001 - org.apache.logging.log4j:log4j-core', 'org.apache.logging.log4j:log4j-core'],
    ['CVE-2026-0001 - github.com/golang/net', 'github.com/golang/net'],
    ['CVE-2026-0001 - @types/node', '@types/node'],
    ['GHSA-abcd-1234-efgh - lodash', 'lodash'],
    // Sem pacote reconhecível vale o CVE (o nome do evento).
    ['CVE-2026-0001', 'CVE-2026-0001'],
    ['CVE-2026-0001 - ', 'CVE-2026-0001'],
    ['CVE-2026-0001 - , x', 'CVE-2026-0001'],
    ['um título qualquer - com traço', 'CVE-2026-0001'],
    ['', 'CVE-2026-0001'],
  ])('o título "%s" dá o subgrupo %s', (title, group) => {
    expect(key({ ...inspector, title: `Vulnerabilidade em pacote: ${title}` }).group).toBe(group);
  });

  it('sem pacote e sem CVE, sobra o recurso', () => {
    const bare = { ...inspector, eventName: null, title: 'Vulnerabilidade em pacote' };
    expect(key(bare).group).toBeNull();
    expect(keyHash(bare)).not.toBe(keyHash({ ...bare, resource: 'ec2:i-0def5678' }));
    expect(keyHash(bare)).not.toBe(keyHash(inspector));
  });

  it('a imagem do ECR vale pelo repositório, sem o digest', () => {
    const image = (repository: string, digest: string, account = ACCOUNT) =>
      keyHash({
        ...inspector,
        resource: `arn:aws:ecr:us-east-1:${account}:repository/${repository}/sha256:${digest.repeat(64)}`,
      });
    expect(image('time/app', 'a')).toBe(image('time/app', 'b'));
    expect(image('time/app', 'a')).not.toBe(image('time/outro', 'a'));
    expect(image('time/app', 'a')).not.toBe(image('time', 'a'));
    expect(image('time/app', 'a')).not.toBe(image('time/app', 'a', OTHER_ACCOUNT));
    // O digest fora do formato não é cortado: não se adivinha.
    expect(
      keyHash({ ...inspector, resource: `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/app/sha256:zz` }),
    ).not.toBe(keyHash({ ...inspector, resource: `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/app` }));
  });

  it('a função Lambda vale sem a versão; a camada, também', () => {
    const lambda = (suffix: string) =>
      keyHash({ ...inspector, resource: `arn:aws:lambda:us-east-1:${ACCOUNT}:${suffix}` });
    expect(lambda('function:cobranca')).toBe(lambda('function:cobranca:$LATEST'));
    expect(lambda('function:cobranca')).toBe(lambda('function:cobranca:12'));
    expect(lambda('function:cobranca')).not.toBe(lambda('function:envio'));
    expect(lambda('layer:comum:1')).toBe(lambda('layer:comum:2'));
    expect(lambda('layer:comum:1')).not.toBe(lambda('function:comum:1'));
  });

  it('a cópia do Inspector pelo Security Hub cai no mesmo caso', () => {
    const copy = {
      logSource: 'security_hub',
      ruleId: '990502',
      eventName: 'Software and Configuration Checks/Vulnerabilities/CVE',
      title: 'Achado do Security Hub (Inspector): CVE-2026-0001 - openssl',
      resource: 'ec2:i-0abc1234',
    };
    expect(key(copy)).toMatchObject({ queue: 'vulnerability', family: 'package', group: 'openssl' });
    expect(keyHash(copy)).toBe(keyHash(inspector));
    // Sem pacote no título, vale o CVE dele.
    expect(key({ ...copy, title: 'Achado do Security Hub (Inspector): CVE-2026-0009' }).group).toBe(
      'CVE-2026-0009',
    );
    // Um produto qualquer que se diga Inspector não leva uma detecção para a fila quieta: o tipo tem de ser o dele.
    expect(key({ ...copy, eventName: 'TTPs/Initial Access' }).queue).toBe('detection');
    expect(key({ ...copy, eventName: null }).queue).toBe('detection');
    expect(key({ ...copy, title: 'Achado do Security Hub (Inspector)' }).queue).toBe('vulnerability');
    // Outro produto com o mesmo tipo é postura, não cópia do Inspector.
    expect(
      key({ ...copy, title: 'Achado do Security Hub (Scanner): CVE-2026-0001 - openssl' }),
    ).toMatchObject({
      queue: 'posture',
      family: 'security-hub-check',
    });
  });

  it('o detector de vulnerabilidades do agente: o pacote do título e a instância', () => {
    const agent = {
      logSource: 'wazuh_agent',
      accountId: 'agent:001',
      ruleId: '23505',
      eventName: 'json',
      resource: 'host:app-1',
      title: 'CVE-2026-0001 affects openssl',
    };
    const base = keyHash(agent);
    expect(key(agent).group).toBe('openssl');
    expect(keyHash({ ...agent, ruleId: '23506', title: 'CVE-2026-0002 affects openssl' })).toBe(base);
    expect(
      keyHash({
        ...agent,
        ruleId: '23508',
        title: 'CVE-2026-0003 affects openssl (Missing information, CVE awaiting analysis)',
      }),
    ).toBe(base);
    expect(
      keyHash({
        ...agent,
        ruleId: '23502',
        title: 'The CVE-2026-0001 that affected openssl was solved due to an update in the agent or feed.',
      }),
    ).toBe(base);
    expect(keyHash({ ...agent, title: 'CVE-2026-0001 affects curl' })).not.toBe(base);
    expect(keyHash({ ...agent, resource: 'host:app-2' })).not.toBe(base);
    // "Vulnerabilities cleared": sem pacote e sem CVE.
    expect(key({ ...agent, ruleId: '23507', title: 'Vulnerabilities cleared' }).group).toBeNull();
  });

  it('a vulnerabilidade no código vale pelo recurso', () => {
    const code = {
      logSource: 'inspector',
      ruleId: '990513',
      resource: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:a:1`,
    };
    expect(keyHash({ ...code, eventName: 'SQL Injection' })).toBe(keyHash({ ...code, eventName: 'XSS' }));
    expect(keyHash(code)).toBe(
      keyHash({ ...code, resource: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:a:2` }),
    );
  });

  it('gravar o subgrupo calculado não muda a chave', () => {
    const next = random(11);
    for (let round = 0; round < 3_000; round += 1) {
      const input = randomFinding(next);
      const first = caseKeyOf(input);
      const again = caseKeyOf({ ...input, caseGroup: first.group });
      expect(again.groupKey, JSON.stringify(input)).toBe(first.groupKey);
      expect(again.group).toBe(first.group);
    }
  });
});

describe('postura', () => {
  it('o controle e a conta; o recurso é só o subgrupo', () => {
    const control = { logSource: 'security_hub', ruleId: '990501', eventName: 'S3.1' };
    expect(keyHash({ ...control, resource: 's3:a' })).toBe(keyHash({ ...control, resource: 's3:b' }));
    expect(key({ ...control, resource: 's3:a' }).group).toBe('s3:a');
    expect(keyHash(control)).not.toBe(keyHash({ ...control, eventName: 'S3.2' }));
    expect(keyHash(control)).not.toBe(keyHash({ ...control, accountId: OTHER_ACCOUNT }));
  });

  it('o controle médio ou baixo vale pelo serviço', () => {
    const control = { logSource: 'security_hub', ruleId: '990501', severity: 'medium' };
    expect(keyHash({ ...control, eventName: 'S3.1' })).toBe(
      keyHash({ ...control, eventName: 'S3.22', severity: 'low' }),
    );
    expect(keyHash({ ...control, eventName: 'S3.1' })).not.toBe(keyHash({ ...control, eventName: 'EC2.1' }));
    // Fora do formato de um controle, um grupo só: um nome inventado não vira um caso.
    expect(keyHash({ ...control, eventName: 'x/y' })).toBe(keyHash({ ...control, eventName: 'z' }));
  });

  it('o achado de produto: detecção se o tipo é de ataque ou desconhecido; senão, postura', () => {
    const product = {
      logSource: 'security_hub',
      ruleId: '990502',
      title: 'Achado do Security Hub (Macie): x',
    };
    for (const eventName of [
      'TTPs/Initial Access',
      'Effects/Data Exposure',
      'Unusual Behaviors/Process',
      'arn:aws:macie::gerador',
      'Software and Configuration',
      'software and configuration checks/x',
      'Outra/Coisa',
      '',
      null,
    ]) {
      expect(key({ ...product, eventName }), String(eventName)).toMatchObject({
        queue: 'detection',
        family: 'security-hub-finding',
      });
    }
    for (const eventName of [
      'Software and Configuration Checks/AWS Security Best Practices',
      'Sensitive Data Identifications/PII',
    ]) {
      expect(key({ ...product, eventName }), eventName).toMatchObject({
        queue: 'posture',
        family: 'security-hub-check',
      });
    }
    const type = 'Sensitive Data Identifications/PII';
    expect(keyHash({ ...product, eventName: type })).toBe(
      keyHash({ ...product, eventName: type, title: 'Achado do Security Hub (Macie): y', resource: 's3:b' }),
    );
    expect(keyHash({ ...product, eventName: type })).not.toBe(
      keyHash({ ...product, eventName: type, title: 'Achado do Security Hub (Outro): x' }),
    );
  });

  it('Access Analyzer: o acesso público por recurso; o resto, por regra', () => {
    const open = { logSource: 'access_analyzer', ruleId: '990521' };
    expect(keyHash({ ...open, resource: 's3:a' })).not.toBe(keyHash({ ...open, resource: 's3:b' }));
    // Nem com severidade alta as outras regras separam por recurso.
    const loud = { logSource: 'access_analyzer', ruleId: '990522', severity: 'high' };
    expect(keyHash({ ...loud, resource: 's3:a' })).toBe(keyHash({ ...loud, resource: 's3:b' }));
    const external = { logSource: 'access_analyzer', ruleId: '990522', severity: 'medium' };
    expect(keyHash({ ...external, resource: 's3:a' })).toBe(keyHash({ ...external, resource: 's3:b' }));
  });

  it('a porta alcançável (Inspector) e a configuração do agente', () => {
    const network = { logSource: 'inspector', ruleId: '990512', eventName: 'TCP/22' };
    expect(keyHash({ ...network, resource: 'ec2:i-0abc1234' })).toBe(
      keyHash({ ...network, eventName: 'TCP/3389', resource: 'ec2:i-0abc1234' }),
    );
    expect(keyHash({ ...network, resource: 'ec2:i-0abc1234' })).not.toBe(
      keyHash({ ...network, resource: 'ec2:i-0def5678' }),
    );
    const sca = { logSource: 'wazuh_agent', accountId: 'agent:001', ruleId: '19007', resource: 'host:app-1' };
    expect(keyHash(sca)).not.toBe(keyHash({ ...sca, ruleId: '19011' }));
  });
});

describe('a faixa de severidade separa o ruído do que é grave', () => {
  it('alta e crítica dividem a chave; média e baixa, a grossa; uma nunca é a outra', () => {
    const next = random(7);
    const fine = new Set<string>();
    const coarse = new Set<string>();
    for (let round = 0; round < 4_000; round += 1) {
      const input = randomFinding(next);
      const keys = Object.fromEntries(
        FINDING_SEVERITIES.map((severity) => [severity, caseKeyOf({ ...input, severity })]),
      );
      const [critical, high, medium, low] = [keys['critical'], keys['high'], keys['medium'], keys['low']];
      expect(critical?.groupKey).toBe(high?.groupKey);
      expect(medium?.groupKey).toBe(low?.groupKey);
      expect(critical?.queue).toBe(medium?.queue);
      if (critical?.queue === 'vulnerability') {
        expect(critical.groupKey).toBe(low?.groupKey);
        continue;
      }
      expect(critical?.tier).toBe('hc');
      expect(low?.tier).toBe('ml');
      expect(critical?.groupKey).not.toBe(low?.groupKey);
      fine.add(critical?.groupKey ?? '');
      coarse.add(low?.groupKey ?? '');
    }
    for (const hash of coarse) expect(fine.has(hash)).toBe(false);
    expect(fine.size).toBeGreaterThan(coarse.size);
  });

  it('a média e a baixa valem por família, conta e regra: nada do que quem ataca escolhe', () => {
    for (const logSource of [
      'cloudtrail',
      'guardduty',
      'waf',
      'vpc_flow',
      'cloudwatch_logs',
      'gcp_audit',
      'wazuh_agent',
    ]) {
      const noisy = { logSource, ruleId: '80202', severity: 'medium' };
      const base = keyHash(noisy);
      expect(
        keyHash({
          ...noisy,
          actorUser: 'x',
          resource: 'y',
          sourceIp: '203.0.113.7',
          eventName: 'z',
          title: 'w',
        }),
        logSource,
      ).toBe(base);
      expect(keyHash({ ...noisy, ruleId: '80203' }), logSource).not.toBe(base);
    }
  });

  it('uma severidade desconhecida vale como grave', () => {
    expect(key({ severity: 'outra' }).tier).toBe('hc');
  });
});

describe('a rede de um IP', () => {
  it.each([
    ['203.0.113.7', 'ipv4:203.0.113.0/24'],
    ['203.0.113.255', 'ipv4:203.0.113.0/24'],
    ['8.8.8.8', 'ipv4:8.8.8.0/24'],
    // Privados e especiais: o endereço exato.
    ['10.1.2.3', 'ipv4:10.1.2.3'],
    ['172.16.0.1', 'ipv4:172.16.0.1'],
    ['172.31.255.254', 'ipv4:172.31.255.254'],
    ['192.168.1.10', 'ipv4:192.168.1.10'],
    ['100.64.0.1', 'ipv4:100.64.0.1'],
    ['100.127.255.254', 'ipv4:100.127.255.254'],
    ['127.0.0.1', 'ipv4:127.0.0.1'],
    ['169.254.1.1', 'ipv4:169.254.1.1'],
    ['0.0.0.0', 'ipv4:0.0.0.0'],
    // As vizinhas das faixas privadas são públicas.
    ['9.255.255.255', 'ipv4:9.255.255.0/24'],
    ['11.0.0.1', 'ipv4:11.0.0.0/24'],
    ['172.15.0.1', 'ipv4:172.15.0.0/24'],
    ['172.32.0.1', 'ipv4:172.32.0.0/24'],
    ['192.167.0.1', 'ipv4:192.167.0.0/24'],
    ['192.169.0.1', 'ipv4:192.169.0.0/24'],
    ['100.63.0.1', 'ipv4:100.63.0.0/24'],
    ['100.128.0.1', 'ipv4:100.128.0.0/24'],
    // IPv6 público: o /64, em qualquer grafia.
    ['2001:db8:1:2::1', 'ipv6:2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', 'ipv6:2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:0000:0000:0000:0001', 'ipv6:2001:db8:1:2::/64'],
    ['2001:db8::1', 'ipv6:2001:db8:0:0::/64'],
    ['2001:db8:1:3::1', 'ipv6:2001:db8:1:3::/64'],
    // IPv6 privado e especial: o endereço exato, em uma grafia só.
    ['fd00::1', 'ipv6:fd00:0:0:0:0:0:0:1'],
    ['FD00:0:0:0::1', 'ipv6:fd00:0:0:0:0:0:0:1'],
    ['fc00::1', 'ipv6:fc00:0:0:0:0:0:0:1'],
    ['fe80::1', 'ipv6:fe80:0:0:0:0:0:0:1'],
    ['fe80::1%eth0', 'ipv6:fe80:0:0:0:0:0:0:1'],
    ['::1', 'ipv6:0:0:0:0:0:0:0:1'],
    ['::', 'ipv6:0:0:0:0:0:0:0:0'],
    // O IPv4 dentro de um IPv6 é o IPv4: o /64 dele juntaria a internet inteira.
    ['::ffff:203.0.113.7', 'ipv4:203.0.113.0/24'],
    ['::ffff:cb00:7107', 'ipv4:203.0.113.0/24'],
    ['0:0:0:0:0:FFFF:CB00:7107', 'ipv4:203.0.113.0/24'],
    ['::ffff:10.0.0.1', 'ipv4:10.0.0.1'],
    ['64:ff9b::203.0.113.7', 'ipv4:203.0.113.0/24'],
    ['64:ff9b::cb00:7107', 'ipv4:203.0.113.0/24'],
  ])('%s é %s', (ip, network) => {
    expect(networkOf(ip)).toBe(network);
  });

  it.each([
    null,
    '',
    ' ',
    'lixo',
    '203.0.113',
    '203.0.113.256',
    '010.0.0.1',
    '203.0.113.7/24',
    ':::',
    '2001:db8::1::2',
    'ec2.amazonaws.com',
    '1.2.3.4, 5.6.7.8',
  ])('%s não é IP', (value) => {
    expect(networkOf(value)).toBeNull();
  });

  it('um IP ilegível cai no próximo passo, sem virar parte da chave', () => {
    const line = { logSource: 'cloudwatch_logs', ruleId: '5763', actorUser: 'a' };
    expect(keyHash({ ...line, sourceIp: 'lixo' })).toBe(keyHash(line));
  });
});

describe('valores hostis', () => {
  it('um valor nunca passa para a parte vizinha (delimitador)', () => {
    const actors = [
      'maria',
      'maria"',
      'maria"],["actor","x',
      'maria","x',
      'maria\\',
      'maria\\"',
      '["maria"]',
      'maria\u0000',
      'maria\n',
      'resource',
      'actor',
    ];
    const keys = [
      ...actors.map((actorUser) => keyHash({ actorUser })),
      ...actors.map((resource) => keyHash({ resource })),
      ...actors.map((ruleId) => keyHash({ ruleId })),
      ...actors.map((accountId) => keyHash({ accountId })),
      ...actors.map((ruleId) => keyHash({ ruleId, actorUser: 'x' })),
      ...actors.map((accountId) => keyHash({ accountId, actorUser: 'x' })),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('chaves iguais só com a mesma fila, família, faixa, conta e partes', () => {
    const next = random(3);
    const seen = new Map<string, string>();
    for (let round = 0; round < 20_000; round += 1) {
      const input = randomFinding(next);
      const found = caseKeyOf(input);
      expect(found.groupKey).toMatch(HASH);
      // As partes mostradas são cortadas; os valores hostis daqui são curtos e entram inteiros.
      const identity = JSON.stringify([
        found.queue,
        found.family,
        found.tier,
        input.accountId.toWellFormed(),
        found.parts,
      ]);
      const known = seen.get(found.groupKey);
      if (known !== undefined) expect(identity).toBe(known);
      seen.set(found.groupKey, identity);
    }
    const identities = new Set(seen.values());
    expect(identities.size).toBe(seen.size);
    expect(seen.size).toBeGreaterThan(5_000);
  });

  it('nunca lança, e cada saída cabe na coluna dela', () => {
    const next = random(5);
    const huge = 'x'.repeat(10_000);
    for (let round = 0; round < 2_000; round += 1) {
      const input = randomFinding(next);
      const stretched: CaseKeyInput =
        round % 4 === 0
          ? {
              ...input,
              title: huge + input.title,
              resource: huge,
              actorUser: huge,
              eventName: huge,
              caseGroup: huge,
            }
          : input;
      const found = caseKeyOf(stretched);
      expect(found.groupKey).toMatch(HASH);
      expect(CASE_FAMILIES).toContain(found.family);
      expect(found.parts.length).toBeLessThanOrEqual(4);
      for (const part of found.parts) {
        expect(part.value.isWellFormed()).toBe(true);
        expect([...part.value].length).toBeLessThanOrEqual(256);
      }
      if (found.group !== null) {
        expect([...found.group].length).toBeLessThanOrEqual(CASE_GROUP_MAX);
        expect(found.group.isWellFormed()).toBe(true);
      }
    }
  });

  it('o caractere partido (um surrogate solto) vale como o banco o grava', () => {
    expect(keyHash({ actorUser: 'maria\ud83d' })).toBe(keyHash({ actorUser: `maria${REPLACEMENT}` }));
    expect(key({ actorUser: 'maria\ud83d' }).parts).toEqual([
      { name: 'rule', value: '100305' },
      { name: 'actor', value: `maria${REPLACEMENT}` },
    ]);
  });

  it('unicode não é normalizado: parecer igual não junta dois nomes', () => {
    const names = [
      'é',
      DECOMPOSED,
      'admin',
      CYRILLIC_ADMIN,
      FULLWIDTH_ADMIN,
      'ADMIN',
      `admin${ZERO_WIDTH}`,
      `${RIGHT_TO_LEFT}admin`,
      ' admin',
    ];
    expect(new Set(names.map((actorUser) => keyHash({ actorUser }))).size).toBe(names.length);
  });

  it('valores com o mesmo começo e tamanho além do mostrado continuam separados', () => {
    const start = 'x'.repeat(2_000);
    expect(keyHash({ resource: `${start}a` })).not.toBe(keyHash({ resource: `${start}b` }));
    expect(key({ resource: `${start}a` }).parts).toEqual(key({ resource: `${start}b` }).parts);
  });

  it('o mesmo alerta, lido de novo, dá a mesma chave', () => {
    const next = random(9);
    for (let round = 0; round < 500; round += 1) {
      const input = randomFinding(next);
      expect(caseKeyOf({ ...input })).toEqual(caseKeyOf(input));
    }
  });
});

describe('a chave do caso que reúne várias chaves', () => {
  const scan = { logSource: 'vpc_flow', ruleId: '100400', sourceIp: '203.0.113.7' };
  const folded = (overrides: Partial<CaseKeyInput>, fold: CaseFold) =>
    foldedCaseKey(finding(overrides), fold);

  it('o formato: o nome da reunião no lugar da faixa, sem a rede; o reunido por fonte, sem a conta', () => {
    expect(folded(scan, 'distributed')).toEqual({
      version: 1,
      queue: 'detection',
      family: 'vpc-flow',
      fold: 'distributed',
      groupKey: hashOf('detection', 'vpc-flow', 'distributed', ACCOUNT, ['rule', '100400']),
      parts: [
        { name: 'rule', value: '100400' },
        { name: 'fold', value: 'distributed' },
      ],
    });
    expect(folded(scan, 'overflow').groupKey).toBe(
      hashOf('detection', 'vpc-flow', 'overflow', ACCOUNT, ['rule', '100400']),
    );
    expect(folded({ ...scan, severity: 'low' }, 'rollup')).toEqual({
      version: 1,
      queue: 'detection',
      family: 'rollup',
      fold: 'rollup',
      groupKey: hashOf('detection', 'rollup', 'rollup', '', ['source', 'vpc_flow']),
      parts: [
        { name: 'source', value: 'vpc_flow' },
        { name: 'fold', value: 'rollup' },
      ],
    });
    // Mudar um destes valores parte os casos reunidos abertos.
    expect(folded(scan, 'distributed').groupKey).toBe(
      '61af21ae3dd5e4be58480967161ecc2ea57ec2359a6f25aa86cd56f99bd11402',
    );
  });

  it('a rede não separa; a regra, a conta, o alvo e a fila separam', () => {
    const hash = (overrides: Partial<CaseKeyInput>) =>
      folded({ ...scan, ...overrides }, 'distributed').groupKey;
    expect(hash({ sourceIp: '198.51.100.9' })).toBe(hash({}));
    expect(hash({ sourceIp: '2001:db8::1' })).toBe(hash({}));
    expect(hash({ ruleId: '100401' })).not.toBe(hash({}));
    expect(hash({ accountId: OTHER_ACCOUNT })).not.toBe(hash({}));
    const waf = { logSource: 'waf', ruleId: '80443', resource: 'acl-a' };
    expect(hash(waf)).not.toBe(hash({ ...waf, resource: 'acl-b' }));
    const rollup = (overrides: Partial<CaseKeyInput>) =>
      folded({ severity: 'low', ...overrides }, 'rollup').groupKey;
    expect(rollup({ ruleId: '1', accountId: OTHER_ACCOUNT, actorUser: 'x' })).toBe(rollup({}));
    expect(rollup({ logSource: 'gcp_audit' })).not.toBe(rollup({}));
    expect(rollup({ logSource: 'security_hub', ruleId: '990501', eventName: 'S3.8' })).not.toBe(
      rollup({ logSource: 'security_hub', ruleId: '990502' }),
    );
  });

  it('nunca é a chave de um alerta, nem a de outra reunião', () => {
    const next = random(11);
    const own = new Set<string>();
    const others = new Map<string, string>();
    for (let round = 0; round < 2_000; round += 1) {
      const input = randomFinding(next);
      own.add(caseKeyOf(input).groupKey);
      for (const fold of ['distributed', 'overflow', 'rollup'] as const) {
        const { groupKey } = foldedCaseKey(input, fold);
        expect(groupKey).toMatch(HASH);
        expect(others.get(groupKey) ?? fold).toBe(fold);
        others.set(groupKey, fold);
      }
    }
    for (const groupKey of others.keys()) expect(own.has(groupKey)).toBe(false);
  });
});

describe('o subgrupo cabe em 128 caracteres sem juntar dois', () => {
  it('até 128 fica como está', () => {
    expect(boundedCaseGroup('openssl')).toBe('openssl');
    const exact = 'a'.repeat(CASE_GROUP_MAX);
    expect(boundedCaseGroup(exact)).toBe(exact);
    // O limite da coluna é em caracteres, não em unidades de 16 bits.
    const emoji = '😀'.repeat(CASE_GROUP_MAX);
    expect(boundedCaseGroup(emoji)).toBe(emoji);
  });

  it('acima disso, o começo e o resumo do valor inteiro: dois valores longos nunca viram o mesmo', () => {
    const start = `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${'servico-'.repeat(40)}`;
    const [a, b] = [boundedCaseGroup(`${start}a`), boundedCaseGroup(`${start}b`)];
    expect(a).not.toBe(b);
    for (const group of [a, b]) {
      expect([...group].length).toBe(CASE_GROUP_MAX);
      expect(group.startsWith('arn:aws:ecs:us-east-1:')).toBe(true);
    }
    expect(boundedCaseGroup(a)).toBe(a);
    const emoji = boundedCaseGroup('😀'.repeat(CASE_GROUP_MAX + 1));
    expect([...emoji].length).toBe(CASE_GROUP_MAX);
    expect(emoji.isWellFormed()).toBe(true);
  });

  it('o recurso longo do controle e o pacote longo passam por ele', () => {
    const long = `arn:aws:ecs:us-east-1:${ACCOUNT}:service/${'x'.repeat(300)}`;
    expect(
      key({ logSource: 'security_hub', ruleId: '990501', eventName: 'ECS.1', resource: long }).group,
    ).toBe(boundedCaseGroup(long));
    const name = 'pacote-'.repeat(30);
    const inspector = { logSource: 'inspector', ruleId: '990511', eventName: 'CVE-2026-0001' };
    const title = `Vulnerabilidade em pacote: CVE-2026-0001 - ${name}`;
    expect(keyHash({ ...inspector, title })).toBe(
      keyHash({ ...inspector, caseGroup: boundedCaseGroup(name) }),
    );
  });
});
