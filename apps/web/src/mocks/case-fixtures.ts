import type { FindingDetail, FindingSeverity, FindingStatus } from '@verax/shared';
import { buildDemoFindings, type DemoFindingTemplate } from './findings-fixtures';
import { DEMO_ACCOUNTS, DEMO_TENANTS } from './fixtures';

/**
 * Os alertas a mais da demonstração com os casos ligados: a fila de vulnerabilidades (Inspector), a de postura (Security
 * Hub), um caso de detecção com muitos alertas e um valor fora do padrão, e o histórico de um caso que voltou depois de
 * tratado. Todos têm mais de 24 horas: o radar e o pulso, das últimas 24 horas, não mudam. Com os casos desligados, eles não
 * existem, e a demonstração é a de sempre. Tudo fictício: CVEs de um ano que ainda não chegou, contas de exemplo.
 */

/** Quantos alertas de vulnerabilidade a demonstração tem (`localStorage['verax.mock.cases.volume']` troca). */
export const DEMO_VULNERABILITIES = 264;
/** O teto do que o ajuste aceita. */
export const MAX_DEMO_VULNERABILITIES = 3_900;

const HOUR = 60;
const DAY = 24 * HOUR;

const ECR = `arn:aws:ecr:sa-east-1:${DEMO_ACCOUNTS.alfaProducao}:repository/loja`;
const LAMBDA = `arn:aws:lambda:sa-east-1:${DEMO_ACCOUNTS.alfaProducao}:function`;

const RESOURCES = {
  payments: `${ECR}/pagamentos`,
  catalog: `${ECR}/catalogo`,
  shop: 'i-0a1b2c3d4e5f67890',
  batch: 'i-0f1e2d3c4b5a69788',
  report: `${LAMBDA}:gera-relatorio`,
} as const;

/** Os pacotes e onde eles estão. O `openssl` é o que tem muitos alertas: passa do que cabe numa requisição só. */
const PACKAGES: readonly { name: string; resources: readonly string[]; weight: number }[] = [
  {
    name: 'openssl',
    resources: [RESOURCES.payments, RESOURCES.catalog, RESOURCES.shop, RESOURCES.batch],
    weight: 13,
  },
  { name: 'curl', resources: [RESOURCES.payments, RESOURCES.shop], weight: 1 },
  { name: 'libxml2', resources: [RESOURCES.catalog], weight: 1 },
  { name: 'log4j-core', resources: [RESOURCES.payments], weight: 1 },
];

const severityAt = (index: number): FindingSeverity => {
  if (index % 88 === 0) return 'critical';
  if (index % 9 === 0) return 'high';
  return index % 2 === 0 ? 'medium' : 'low';
};

/** As vulnerabilidades, do mesmo jeito que o Inspector as manda: uma por CVE, pacote e recurso. */
function vulnerabilities(volume: number): DemoFindingTemplate[] {
  const weight = PACKAGES.reduce((sum, entry) => sum + entry.weight, 0);
  const templates: DemoFindingTemplate[] = [];
  let index = 0;
  for (const entry of PACKAGES) {
    const share = Math.max(entry.resources.length, Math.round((volume * entry.weight) / weight));
    for (let i = 0; i < share && templates.length < volume; i += 1) {
      const status: FindingStatus = index % 40 === 7 ? 'investigating' : 'new';
      templates.push({
        title: `Vulnerabilidade em pacote: CVE-2099-${String(10_000 + index)} - ${entry.name}`,
        source: 'inspector',
        severity: severityAt(index),
        status,
        minutesAgo: DAY + 2 * HOUR + ((index * 97) % (20 * DAY)),
        ruleId: '990511',
        ruleLevel: 7,
        eventName: `CVE-2099-${String(10_000 + index)}`,
        region: 'sa-east-1',
        resource: entry.resources[i % entry.resources.length],
      });
      index += 1;
    }
  }
  return templates;
}

/** Vulnerabilidade no código: não tem pacote, e fica no grupo sem valor. */
const CODE: DemoFindingTemplate[] = [
  {
    title: 'Vulnerabilidade no código: segredo escrito no código da função',
    source: 'inspector',
    severity: 'high',
    status: 'new',
    minutesAgo: 3 * DAY,
    ruleId: '990513',
    ruleLevel: 10,
    eventName: 'CODE-SECRET',
    region: 'sa-east-1',
    resource: RESOURCES.report,
  },
  // Já resolvidas, mas o Inspector voltou a ver duas (ver `STILL_ACTIVE`).
  ...[0, 1, 2].map((index): DemoFindingTemplate => ({
    title: `Vulnerabilidade em pacote: CVE-2099-2000${index} - zlib`,
    source: 'inspector',
    severity: 'medium',
    status: 'resolved',
    minutesAgo: 12 * DAY + index * HOUR,
    ruleId: '990511',
    ruleLevel: 7,
    eventName: `CVE-2099-2000${index}`,
    region: 'sa-east-1',
    resource: RESOURCES.batch,
  })),
  {
    title: 'Vulnerabilidade em pacote: CVE-2099-20009 - zlib',
    source: 'inspector',
    severity: 'medium',
    status: 'new',
    minutesAgo: 2 * DAY,
    ruleId: '990511',
    ruleLevel: 7,
    eventName: 'CVE-2099-20009',
    region: 'sa-east-1',
    resource: RESOURCES.batch,
  },
];
/** As CVEs que a origem voltou a ver depois de resolvidas. */
export const DEMO_STILL_ACTIVE: ReadonlySet<string> = new Set(['CVE-2099-20000', 'CVE-2099-20001']);

const control = (
  controlId: string,
  title: string,
  severity: FindingSeverity,
  resource: string,
  minutesAgo: number,
): DemoFindingTemplate => ({
  title: `Controle de segurança reprovado (${controlId}): ${title}`,
  source: 'security_hub',
  severity,
  status: 'new',
  minutesAgo,
  ruleId: '990501',
  ruleLevel: 7,
  eventName: controlId,
  region: 'sa-east-1',
  resource,
});

const POSTURE: DemoFindingTemplate[] = [
  control(
    'S3.8',
    'bucket sem o bloqueio de acesso público',
    'high',
    'arn:aws:s3:::loja-exemplo-backups',
    2 * DAY,
  ),
  control(
    'S3.8',
    'bucket sem o bloqueio de acesso público',
    'high',
    'arn:aws:s3:::loja-exemplo-relatorios',
    2 * DAY + 10,
  ),
  control(
    'S3.8',
    'bucket sem o bloqueio de acesso público',
    'high',
    'arn:aws:s3:::loja-exemplo-imagens',
    2 * DAY + 20,
  ),
  control(
    'EC2.19',
    'porta de risco alto aberta para a internet',
    'critical',
    'sg-0123456789abcdef0',
    3 * DAY,
  ),
  control('S3.9', 'bucket sem registro de acesso', 'medium', 'arn:aws:s3:::loja-exemplo-relatorios', 4 * DAY),
  control(
    'S3.11',
    'bucket sem notificação de evento',
    'medium',
    'arn:aws:s3:::loja-exemplo-imagens',
    4 * DAY + 5,
  ),
  control(
    'S3.13',
    'bucket sem regra de ciclo de vida',
    'low',
    'arn:aws:s3:::loja-exemplo-backups',
    4 * DAY + 9,
  ),
];

/** O caso grande de detecção: chamadas negadas em sequência, quase todas do mesmo lugar, e uma que foge do padrão. */
const DENIED: DemoFindingTemplate[] = Array.from({ length: 48 }, (_, index): DemoFindingTemplate => {
  const odd = index === 47;
  const job = index % 8 === 3;
  return {
    title: 'Chamadas negadas por falta de permissão (AccessDenied) em sequência',
    source: 'cloudtrail',
    severity: 'low',
    status: 'new',
    minutesAgo: DAY + 3 * HOUR + index * 110,
    ruleId: '80202',
    ruleLevel: 5,
    eventName: odd ? 'GetSecretValue' : 'ListBuckets',
    region: 'us-east-1',
    user: odd ? 'convidado-temporario' : job ? 'etl-noturno' : 'relatorios-app',
    userType: 'AssumedRole',
    ip: odd ? '198.51.100.200' : job ? '203.0.113.61' : '203.0.113.60',
    tactics: ['Discovery'],
    techniques: ['T1619'],
  };
});

const DETECTION: DemoFindingTemplate[] = [
  {
    title: 'Senha de console trocada por outra pessoa',
    source: 'cloudtrail',
    severity: 'high',
    status: 'new',
    minutesAgo: DAY + 4 * HOUR,
    ruleId: '80258',
    ruleLevel: 10,
    eventName: 'UpdateLoginProfile',
    region: 'us-east-1',
    resource: `arn:aws:iam::${DEMO_ACCOUNTS.alfaProducao}:user/admin-financeiro`,
    user: 'ana.souza',
    userType: 'IAMUser',
    ip: '203.0.113.10',
    tactics: ['Persistence'],
    techniques: ['T1098'],
  },
  // O caso anterior do "Grupo de log do CloudWatch apagado": tratado há 9 dias, e a chave voltou.
  ...[0, 1, 2].map((index): DemoFindingTemplate => ({
    title: 'Grupo de log do CloudWatch apagado',
    source: 'cloudtrail',
    severity: 'high',
    status: 'legitimate',
    minutesAgo: 10 * DAY + index * 30,
    ruleId: '80262',
    ruleLevel: 10,
    eventName: 'DeleteLogGroup',
    region: 'sa-east-1',
    resource: '/aws/lambda/pagamentos',
    user: 'joao.lima',
    userType: 'IAMUser',
    ip: '203.0.113.12',
    tactics: ['Defense Evasion'],
    techniques: ['T1070'],
  })),
];

/** Os alertas a mais, por cliente, no mesmo formato dos outros. */
export function demoCaseFindings(
  volume: number = DEMO_VULNERABILITIES,
  now: Date = new Date(),
): Map<string, FindingDetail[]> {
  const [alfa] = DEMO_TENANTS.map((tenant) => tenant.id);
  return new Map([
    [
      alfa ?? '',
      buildDemoFindings(
        [
          ...DETECTION,
          ...DENIED,
          ...POSTURE,
          ...CODE,
          ...vulnerabilities(Math.min(volume, MAX_DEMO_VULNERABILITIES)),
        ],
        0x30,
        DEMO_ACCOUNTS.alfaProducao,
        now,
      ),
    ],
  ]);
}
