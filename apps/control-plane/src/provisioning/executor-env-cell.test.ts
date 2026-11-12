import { describe, expect, it } from 'vitest';
import {
  CELL_ACTION_OF_KIND,
  CELL_GCP_SOURCES_MAX,
  type CellTenantExecutorInput,
  cellTenantExecutorEnv,
  ExecutorInputError,
} from './executor-env.js';

const UUID_A = '0190a8c0-0000-7000-8000-00000000000a';
const UUID_B = '0190a8c0-0000-7000-8000-00000000000b';
const WRITER_A = 'serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com';
const WRITER_B = 'serviceAccount:service-310987654321@gcp-sa-logging.iam.gserviceaccount.com';

const input: CellTenantExecutorInput = {
  kind: 'cell_provision',
  runId: '01JBTESTE0000000000000RVN1',
  slug: 'cliente-demo-a',
  cellId: 'sp1',
  cellProjectId: 'projeto-exemplo-celula',
  cellRegion: 'southamerica-east1',
  cellNodeServiceAccount: 'verax-celula@projeto-exemplo-celula.iam.gserviceaccount.com',
  // Fora de ordem: a lista sai em ordem de UUID, como o `jq -cS` do entrypoint.
  gcpSources: [
    { cloudAccountId: UUID_B, projectId: 'projeto-do-cliente-a2', writerIdentity: WRITER_B },
    { cloudAccountId: UUID_A, projectId: 'projeto-do-cliente-a1', writerIdentity: WRITER_A },
  ],
};

const refused = (variable: string) => new ExecutorInputError(variable);

describe('as variáveis do executor para o cliente da célula (CE-07)', () => {
  it('a lista inteira, na ordem fixa, com as contas GCP em JSON canônico (o mesmo do entrypoint.sh)', () => {
    expect(cellTenantExecutorEnv(input)).toEqual([
      { name: 'EXECUTOR_ACTION', value: 'apply' },
      { name: 'RUN_KIND', value: 'cell_provision' },
      { name: 'RUN_ID', value: input.runId },
      { name: 'TENANT_SLUG', value: 'cliente-demo-a' },
      { name: 'CELL_ID', value: 'sp1' },
      { name: 'CELL_PROJECT_ID', value: 'projeto-exemplo-celula' },
      { name: 'CELL_REGION', value: 'southamerica-east1' },
      { name: 'CELL_NODE_SA', value: 'verax-celula@projeto-exemplo-celula.iam.gserviceaccount.com' },
      {
        name: 'GCP_SOURCES',
        value: `{"${UUID_A}":{"project_id":"projeto-do-cliente-a1","writer_identity":"${WRITER_A}"},"${UUID_B}":{"project_id":"projeto-do-cliente-a2","writer_identity":"${WRITER_B}"}}`,
      },
    ]);
  });

  it('a ação é a do tipo: só o expurgo destrói', () => {
    expect(CELL_ACTION_OF_KIND).toEqual({
      cell_provision: 'apply',
      cell_sources: 'apply',
      cell_delete: 'destroy',
    });
    expect(cellTenantExecutorEnv({ ...input, kind: 'cell_delete' }).slice(0, 2)).toEqual([
      { name: 'EXECUTOR_ACTION', value: 'destroy' },
      { name: 'RUN_KIND', value: 'cell_delete' },
    ]);
    expect(cellTenantExecutorEnv({ ...input, kind: 'cell_sources' })[0]?.value).toBe('apply');
    expect(() => cellTenantExecutorEnv({ ...input, kind: 'provision' as never })).toThrow(
      refused('RUN_KIND'),
    );
  });

  it('sem conta GCP: o JSON vazio', () => {
    expect(cellTenantExecutorEnv({ ...input, gcpSources: [] }).at(-1)).toEqual({
      name: 'GCP_SOURCES',
      value: '{}',
    });
  });

  it('recusa cada variável fora do formato, citando só o nome', () => {
    const cases: [Partial<CellTenantExecutorInput>, string][] = [
      [{ runId: 'nao-e-ulid' }, 'RUN_ID'],
      [{ slug: 'ab--cliente' }, 'TENANT_SLUG'],
      [{ cellId: 'SP-1' }, 'CELL_ID'],
      [{ cellId: 'celula-muito-longa' }, 'CELL_ID'],
      [{ cellProjectId: 'Projeto' }, 'CELL_PROJECT_ID'],
      [{ cellRegion: 'sao paulo' }, 'CELL_REGION'],
      [{ cellNodeServiceAccount: 'verax-celula@outro-projeto-123.iam.gserviceaccount.com' }, 'CELL_NODE_SA'],
      [{ cellNodeServiceAccount: 'x@projeto-exemplo-celula.iam.gserviceaccount.com' }, 'CELL_NODE_SA'],
      [
        {
          gcpSources: [
            { cloudAccountId: UUID_A.toUpperCase(), projectId: 'projeto-a1', writerIdentity: WRITER_A },
          ],
        },
        'GCP_SOURCES',
      ],
      [
        { gcpSources: [{ cloudAccountId: UUID_A, projectId: '${file("x")}', writerIdentity: WRITER_A }] },
        'GCP_SOURCES',
      ],
      [
        {
          gcpSources: [
            {
              cloudAccountId: UUID_A,
              projectId: 'projeto-a1',
              writerIdentity: 'serviceAccount:alguem@projeto-a1.iam.gserviceaccount.com',
            },
          ],
        },
        'GCP_SOURCES',
      ],
      [
        {
          gcpSources: [
            { cloudAccountId: UUID_A, projectId: 'projeto-a1', writerIdentity: WRITER_A },
            { cloudAccountId: UUID_B, projectId: 'projeto-a2', writerIdentity: WRITER_A },
          ],
        },
        'GCP_SOURCES',
      ],
      [
        {
          gcpSources: [
            { cloudAccountId: UUID_A, projectId: 'projeto-a1', writerIdentity: WRITER_A },
            { cloudAccountId: UUID_B, projectId: 'projeto-a1', writerIdentity: WRITER_B },
          ],
        },
        'GCP_SOURCES',
      ],
      [
        {
          gcpSources: [
            { cloudAccountId: UUID_A, projectId: 'projeto-a1', writerIdentity: WRITER_A },
            { cloudAccountId: UUID_A, projectId: 'projeto-a2', writerIdentity: WRITER_B },
          ],
        },
        'GCP_SOURCES',
      ],
    ];
    for (const [change, variable] of cases) {
      expect(() => cellTenantExecutorEnv({ ...input, ...change })).toThrow(refused(variable));
    }
  });

  it(`no máximo ${CELL_GCP_SOURCES_MAX} contas GCP por cliente`, () => {
    const many = Array.from({ length: CELL_GCP_SOURCES_MAX + 1 }, (_, index) => {
      const suffix = index.toString(16).padStart(12, '0');
      return {
        cloudAccountId: `0190a8c0-0000-7000-8000-${suffix}`,
        projectId: `projeto-cliente-${index}`,
        writerIdentity: `serviceAccount:service-${100000 + index}@gcp-sa-logging.iam.gserviceaccount.com`,
      };
    });
    expect(() => cellTenantExecutorEnv({ ...input, gcpSources: many })).toThrow(refused('GCP_SOURCES'));
    expect(cellTenantExecutorEnv({ ...input, gcpSources: many.slice(0, CELL_GCP_SOURCES_MAX) })).toHaveLength(
      9,
    );
  });
});
