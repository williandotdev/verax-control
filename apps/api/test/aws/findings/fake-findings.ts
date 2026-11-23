import { randomUUID } from 'node:crypto';
import { awsError } from '../../inventory/fake-aws.js';
import { fakeDiscovery, type Handlers } from '../discovery/fake-discovery.js';

/**
 * As APIs de achados de uma conta AWS fictícia, para os testes da tarefa `aws-findings`: o GuardDuty, o Security Hub, o
 * Inspector e o Access Analyzer, com os filtros e a paginação de cada um como a AWS os faz. Nada sai para a rede. Os
 * registros têm o formato que o SDK entrega (campos com maiúscula no GuardDuty e no Security Hub, `Date` nos horários
 * do Inspector e do Access Analyzer). Contas e recursos fictícios.
 *
 * O teste muda a conta entre uma execução e outra (`account.guardduty['sa-east-1'].findings.push(...)`) e programa
 * falhas por chamada (`failures`). As chamadas ficam em `calls`.
 */

type Raw = Record<string, unknown>;

export interface FakeFindingsAccount {
  accountId: string;
  /** O tamanho de página do falso (menor que o pedido, para paginar com poucos registros). */
  pageSize?: number;
  guardduty?: Record<string, { detectorId: string; findings: Raw[] }>;
  securityhub?: Record<string, { findings: Raw[] }>;
  inspector?: Record<string, { findings: Raw[] }>;
  /** Os analisadores de cada região, com os achados e os detalhes de cada um. */
  analyzers?: Record<string, { name: string; arn: string; findings: Raw[]; details?: Record<string, Raw> }[]>;
  /** Erros programados: `serviço:região:Comando` (ou `serviço:*:Comando`), consumidos na ordem, um por chamada. */
  failures?: Record<string, Error[]>;
  /** Handlers a mais ou no lugar dos padrões (`serviço:região`, depois o nome do comando). */
  handlers?: Record<string, Handlers>;
  /** Chamado a cada comando dos serviços de achados, antes da resposta (para o teste agir no meio de uma leitura). */
  onCall?: (service: string, region: string, command: string) => void;
}

/** A página `[offset, offset + size)` de uma lista, com a continuação (a posição seguinte, em texto). */
function pageOf<T>(
  items: readonly T[],
  token: unknown,
  size: number,
): { items: T[]; next: string | undefined } {
  const offset = typeof token === 'string' ? Number(token.replace(/^pos-/, '')) : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > items.length) {
    throw awsError('ValidationException');
  }
  const slice = items.slice(offset, offset + size);
  const end = offset + slice.length;
  return { items: slice, next: end < items.length ? `pos-${end}` : undefined };
}

const time = (value: unknown): number =>
  value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;

export function fakeFindings(account: FakeFindingsAccount) {
  const size = (asked: unknown, max: number) =>
    Math.min(typeof asked === 'number' ? asked : max, account.pageSize ?? max, max);

  /** Lança o próximo erro programado para o comando, se houver. */
  function fail(service: string, region: string, command: string): void {
    account.onCall?.(service, region, command);
    const queue =
      account.failures?.[`${service}:${region}:${command}`] ?? account.failures?.[`${service}:*:${command}`];
    const error = queue?.shift();
    if (error !== undefined) throw error;
  }

  const guarded = (service: string, region: string, handlers: Handlers): Handlers =>
    Object.fromEntries(
      Object.entries(handlers).map(([command, handler]) => [
        command,
        (input: Raw) => {
          fail(service, region, command);
          return handler(input);
        },
      ]),
    );

  const handlers: Record<string, Handlers> = {};
  const regions = new Set<string>([
    ...Object.keys(account.guardduty ?? {}),
    ...Object.keys(account.securityhub ?? {}),
    ...Object.keys(account.inspector ?? {}),
    ...Object.keys(account.analyzers ?? {}),
  ]);

  for (const region of regions) {
    handlers[`guardduty:${region}`] = guarded('guardduty', region, {
      ListDetectorsCommand: () => {
        const detector = account.guardduty?.[region];
        return { DetectorIds: detector === undefined ? [] : [detector.detectorId] };
      },
      ListFindingsCommand: (input) => {
        const detector = account.guardduty?.[region];
        if (detector === undefined || input['DetectorId'] !== detector.detectorId) {
          throw awsError('BadRequestException');
        }
        const criterion = (input['FindingCriteria'] as { Criterion?: Record<string, Raw> } | undefined)
          ?.Criterion;
        const since = criterion?.['updatedAt']?.['GreaterThanOrEqual'];
        const unarchived =
          (criterion?.['service.archived']?.['Equals'] as string[] | undefined)?.[0] === 'false';
        const matching = detector.findings
          .filter((finding) => typeof since !== 'number' || time(finding['UpdatedAt']) >= since)
          .filter((finding) => !unarchived || (finding['Service'] as Raw | undefined)?.['Archived'] !== true);
        const page = pageOf(matching, input['NextToken'], size(input['MaxResults'], 50));
        return { FindingIds: page.items.map((finding) => finding['Id']), NextToken: page.next };
      },
      GetFindingsCommand: (input) => {
        const ids = (input['FindingIds'] as string[] | undefined) ?? [];
        if (ids.length > 50) throw awsError('BadRequestException');
        const findings = account.guardduty?.[region]?.findings ?? [];
        return { Findings: findings.filter((finding) => ids.includes(finding['Id'] as string)) };
      },
    });

    handlers[`securityhub:${region}`] = guarded('securityhub', region, {
      GetFindingsCommand: (input) => {
        const hub = account.securityhub?.[region];
        // O Security Hub desligado na região responde assim.
        if (hub === undefined) throw awsError('InvalidAccessException');
        const filters = (input['Filters'] ?? {}) as Record<string, Raw[] | undefined>;
        const range = filters['UpdatedAt']?.[0];
        const values = (name: string) => (filters[name] ?? []).map((filter) => filter['Value']);
        const states = values('RecordState');
        const workflows = values('WorkflowStatus');
        const matching = hub.findings.filter((finding) => {
          const at = time(finding['UpdatedAt']);
          if (range !== undefined && (at < time(range['Start']) || at > time(range['End']))) return false;
          if (states.length > 0 && !states.includes(finding['RecordState'] ?? 'ACTIVE')) return false;
          const workflow = (finding['Workflow'] as Raw | undefined)?.['Status'] ?? 'NEW';
          return workflows.length === 0 || workflows.includes(workflow);
        });
        const page = pageOf(matching, input['NextToken'], size(input['MaxResults'], 100));
        return { Findings: page.items, NextToken: page.next };
      },
    });

    handlers[`inspector2:${region}`] = guarded('inspector2', region, {
      BatchGetAccountStatusCommand: () => ({
        accounts: [
          {
            accountId: account.accountId,
            state: { status: account.inspector?.[region] === undefined ? 'DISABLED' : 'ENABLED' },
          },
        ],
      }),
      ListFindingsCommand: (input) => {
        const inspector = account.inspector?.[region];
        // O Inspector desligado responde acesso negado, como a permissão que falta.
        if (inspector === undefined) throw awsError('AccessDeniedException');
        const criteria = (input['filterCriteria'] ?? {}) as Record<string, Raw[] | undefined>;
        const range = criteria['updatedAt']?.[0];
        const statuses = (criteria['findingStatus'] ?? []).map((filter) => filter['value']);
        const matching = inspector.findings.filter((finding) => {
          const at = time(finding['updatedAt']);
          if (
            range !== undefined &&
            (at < time(range['startInclusive']) || at > time(range['endInclusive']))
          ) {
            return false;
          }
          return statuses.length === 0 || statuses.includes(finding['status'] ?? 'ACTIVE');
        });
        const page = pageOf(matching, input['nextToken'], size(input['maxResults'], 100));
        return { findings: page.items, nextToken: page.next };
      },
    });

    handlers[`accessanalyzer:${region}`] = guarded('accessanalyzer', region, {
      ListAnalyzersCommand: () => ({
        analyzers: (account.analyzers?.[region] ?? []).map((analyzer) => ({
          name: analyzer.name,
          arn: analyzer.arn,
          type: 'ACCOUNT',
          status: 'ACTIVE',
        })),
      }),
      ListFindingsV2Command: (input) => {
        const analyzer = (account.analyzers?.[region] ?? []).find(
          (item) => item.arn === input['analyzerArn'],
        );
        if (analyzer === undefined) throw awsError('ResourceNotFoundException');
        const statuses = (input['filter'] as { status?: { eq?: string[] } } | undefined)?.status?.eq ?? [];
        const matching = analyzer.findings.filter(
          (finding) => statuses.length === 0 || statuses.includes((finding['status'] as string) ?? 'ACTIVE'),
        );
        const page = pageOf(matching, input['nextToken'], size(input['maxResults'], 100));
        return { findings: page.items, nextToken: page.next };
      },
      GetFindingV2Command: (input) => {
        const analyzer = (account.analyzers?.[region] ?? []).find(
          (item) => item.arn === input['analyzerArn'],
        );
        const summary = analyzer?.findings.find((finding) => finding['id'] === input['id']);
        if (analyzer === undefined || summary === undefined) throw awsError('ResourceNotFoundException');
        return { ...summary, findingDetails: [], ...analyzer.details?.[input['id'] as string] };
      },
    });
  }

  const fake = fakeDiscovery({
    regions: [...regions],
    handlers: { ...handlers, ...account.handlers },
  });
  return {
    ...fake,
    /** As chamadas a um serviço, por comando (em qualquer região, ou numa). */
    count: (service: string, command: string, region?: string) =>
      fake.calls.filter(
        (call) =>
          call.service === service &&
          call.command === command &&
          (region === undefined || call.region === region),
      ).length,
    /** A entrada de cada chamada de um comando, na ordem. */
    inputs: (service: string, command: string) =>
      fake.calls
        .filter((call) => call.service === service && call.command === command)
        .map((call) => call.input),
  };
}

export { awsError };

// --- Registros, no formato que o SDK entrega ---

const hexId = () => randomUUID().replace(/-/g, '');

/** Um achado do `GetFindings` do GuardDuty: o mesmo do export para o S3, com a primeira letra de cada campo maiúscula. */
export function guardDutyFinding(
  options: {
    account: string;
    id?: string;
    region?: string;
    severity?: number;
    updatedAt?: string;
    type?: string;
    title?: string;
    archived?: boolean;
    action?: Raw;
    resource?: Raw;
  } = { account: '111111111111' },
): Raw {
  const id = options.id ?? hexId();
  const region = options.region ?? 'sa-east-1';
  const updatedAt = options.updatedAt ?? '2026-11-22T09:55:00.000Z';
  return {
    SchemaVersion: '2.0',
    AccountId: options.account,
    Region: region,
    Partition: 'aws',
    Id: id,
    Arn: `arn:aws:guardduty:${region}:${options.account}:detector/0000/finding/${id}`,
    Type: options.type ?? 'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
    Title: options.title ?? 'Credenciais usadas de fora da AWS',
    Description: 'Descrição que nunca é guardada.',
    Severity: options.severity ?? 8,
    CreatedAt: '2026-11-22T09:00:00.000Z',
    UpdatedAt: updatedAt,
    Resource: options.resource ?? {
      ResourceType: 'AccessKey',
      AccessKeyDetails: {
        AccessKeyId: 'ASIAEXEMPLO000000000',
        PrincipalId: 'AROAEXEMPLO0000000000:i-0abc1234',
        UserName: 'papel-da-aplicacao',
        UserType: 'AssumedRole',
      },
      InstanceDetails: { InstanceId: 'i-0abc1234def567890' },
    },
    Service: {
      ServiceName: 'guardduty',
      Archived: options.archived ?? false,
      Count: 1,
      EventFirstSeen: '2026-11-22T09:00:00.000Z',
      EventLastSeen: updatedAt,
      Action: options.action ?? {
        ActionType: 'AWS_API_CALL',
        AwsApiCallAction: { Api: 'ListBuckets', RemoteIpDetails: { IpAddressV4: '198.51.100.7' } },
      },
    },
  };
}

/** A ação de uma sondagem de porta, com um item por IP e porta. */
export function portProbeAction(probes: readonly { ip: string; port: number }[]): Raw {
  return {
    ActionType: 'PORT_PROBE',
    PortProbeAction: {
      Blocked: false,
      PortProbeDetails: probes.map(({ ip, port }) => ({
        LocalPortDetails: { Port: port, PortName: port === 22 ? 'SSH' : 'Unknown' },
        LocalIpDetails: { IpAddressV4: '10.0.0.10' },
        RemoteIpDetails: { IpAddressV4: ip, Organization: { AsnOrg: 'Exemplo' } },
      })),
    },
  };
}

/** Um achado do `GetFindings` do Security Hub (ASFF). O padrão é um controle reprovado do próprio Security Hub. */
export function securityHubFinding(
  options: {
    account: string;
    id?: string;
    region?: string;
    product?: 'securityhub' | 'guardduty' | 'inspector' | 'macie';
    label?: string;
    updatedAt?: string;
    title?: string;
    workflow?: string;
    recordState?: string;
    controlId?: string | null;
    resourceId?: string;
    types?: string[];
  } = { account: '111111111111' },
): Raw {
  const region = options.region ?? 'sa-east-1';
  const product = options.product ?? 'securityhub';
  const names = {
    securityhub: 'Security Hub',
    guardduty: 'GuardDuty',
    inspector: 'Inspector',
    macie: 'Macie',
  };
  const controlId = options.controlId === undefined ? 'S3.8' : options.controlId;
  const id =
    options.id ??
    `arn:aws:securityhub:${region}:${options.account}:security-control/${controlId ?? 'x'}/finding/${randomUUID()}`;
  return {
    SchemaVersion: '2018-10-08',
    Id: id,
    ProductArn: `arn:aws:securityhub:${region}::product/aws/${product}`,
    ProductName: names[product],
    CompanyName: 'AWS',
    Region: region,
    GeneratorId: `security-control/${controlId ?? 'x'}`,
    AwsAccountId: options.account,
    Types: options.types ?? ['Software and Configuration Checks/Industry and Regulatory Standards'],
    CreatedAt: '2026-11-20T08:00:00.000Z',
    UpdatedAt: options.updatedAt ?? '2026-11-22T09:55:00.000Z',
    Severity: { Label: options.label ?? 'HIGH', Normalized: 70 },
    Title: options.title ?? 'S3 general purpose buckets should block public access',
    Description: 'Descrição que nunca é guardada.',
    Resources: [
      {
        Type: 'AwsS3Bucket',
        Id: options.resourceId ?? 'arn:aws:s3:::bucket-de-exemplo',
        Partition: 'aws',
        Region: region,
      },
    ],
    ...(product === 'securityhub' &&
      controlId !== null && { Compliance: { Status: 'FAILED', SecurityControlId: controlId } }),
    Workflow: { Status: options.workflow ?? 'NEW' },
    RecordState: options.recordState ?? 'ACTIVE',
  };
}

/** Um achado do `ListFindings` do Inspector2. O padrão é uma vulnerabilidade de pacote crítica numa instância. */
export function inspectorFinding(
  options: {
    account: string;
    id?: string;
    region?: string;
    severity?: string;
    updatedAt?: Date;
    type?: string;
    status?: string;
    title?: string;
    cve?: string;
  } = { account: '111111111111' },
): Raw {
  const region = options.region ?? 'sa-east-1';
  const type = options.type ?? 'PACKAGE_VULNERABILITY';
  const cve = options.cve ?? 'CVE-2026-0001';
  const updatedAt = options.updatedAt ?? new Date('2026-11-22T09:55:00.000Z');
  return {
    findingArn: `arn:aws:inspector2:${region}:${options.account}:finding/${options.id ?? hexId()}`,
    awsAccountId: options.account,
    type,
    title: options.title ?? `${cve} - openssl`,
    description: 'Descrição que nunca é guardada.',
    severity: options.severity ?? 'CRITICAL',
    status: options.status ?? 'ACTIVE',
    firstObservedAt: new Date('2026-11-20T08:00:00.000Z'),
    lastObservedAt: updatedAt,
    updatedAt,
    resources: [{ type: 'AWS_EC2_INSTANCE', id: 'i-0abc1234def567890', region, partition: 'aws' }],
    ...(type === 'PACKAGE_VULNERABILITY' && {
      packageVulnerabilityDetails: { vulnerabilityId: cve, source: 'NVD', vulnerablePackages: [] },
    }),
    ...(type === 'NETWORK_REACHABILITY' && {
      networkReachabilityDetails: { openPortRange: { begin: 22, end: 22 }, protocol: 'TCP' },
    }),
  };
}

/** Um achado do `ListFindingsV2` do Access Analyzer. O padrão é o acesso externo a um bucket. */
export function analyzerFinding(
  options: {
    account: string;
    id?: string;
    findingType?: string;
    resource?: string;
    resourceType?: string;
    updatedAt?: Date;
    status?: string;
  } = { account: '111111111111' },
): Raw {
  const updatedAt = options.updatedAt ?? new Date('2026-11-22T09:55:00.000Z');
  return {
    id: options.id ?? randomUUID(),
    findingType: options.findingType ?? 'ExternalAccess',
    resource: options.resource ?? 'arn:aws:s3:::bucket-de-exemplo',
    resourceType: options.resourceType ?? 'AWS::S3::Bucket',
    resourceOwnerAccount: options.account,
    status: options.status ?? 'ACTIVE',
    createdAt: new Date('2026-11-01T08:00:00.000Z'),
    analyzedAt: updatedAt,
    updatedAt,
  };
}

/** O detalhe (`GetFindingV2`) de um acesso externo: público ou de outra conta. */
export function externalAccessDetail(isPublic: boolean): Raw {
  return {
    findingDetails: [
      {
        externalAccessDetails: {
          isPublic,
          action: ['s3:GetObject'],
          condition: {},
          principal: isPublic ? { AWS: '*' } : { AWS: '222222222222' },
        },
      },
    ],
  };
}
