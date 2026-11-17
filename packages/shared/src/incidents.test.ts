import { describe, expect, it } from 'vitest';
import {
  type Incident,
  incidentAttachSchema,
  incidentCreateSchema,
  incidentListQuerySchema,
  incidentSchema,
  incidentUpdateSchema,
} from './incidents.js';

const incident: Incident = {
  id: '018f2c1e-0000-7000-8000-0000000a0001',
  severity: 'critical',
  status: 'investigating',
  riskScore: 82,
  findingCount: 3,
  firstSeenAt: '2026-11-02T12:20:00.000Z',
  lastSeenAt: '2026-11-02T12:35:00.000Z',
  keys: ['key:AKIAIOSFODNN7EXAMPLE', 'user:deploy-bot', 'ip:198.51.100.23'],
  accounts: ['111122223333'],
  resources: ['arn:aws:iam::111122223333:user/admin-financeiro'],
  mitreTactics: ['Defense Evasion', 'Persistence'],
  assignee: { id: 'u1', name: 'Equipe Verax' },
};

describe('incidentes', () => {
  it('aceita o incidente da lista, inclusive sem responsável', () => {
    expect(incidentSchema.parse(incident)).toEqual(incident);
    expect(incidentSchema.safeParse({ ...incident, assignee: null }).success).toBe(true);
  });

  it('entre as origens, o agente do Wazuh de uma instância do cliente (`agent:<id>`), ao lado das contas', () => {
    const accounts = ['111122223333', 'agent:001'];
    expect(incidentSchema.parse({ ...incident, accounts }).accounts).toEqual(accounts);
    expect(incidentSchema.safeParse({ ...incident, accounts: ['agent:x'] }).success).toBe(false);
  });

  it.each([
    ['nota acima de 100', { riskScore: 101 }],
    ['incidente sem achado', { findingCount: 0 }],
    ['chave de agrupamento desconhecida', { keys: ['email:x@y'] }],
    ['status desconhecido', { status: 'closed' }],
  ])('recusa %s', (_name, change) => {
    expect(incidentSchema.safeParse({ ...incident, ...change }).success).toBe(false);
  });

  it('aceita incidente sem chave: a pessoa pode confirmar alerta sem usuário, chave, IP nem recurso', () => {
    expect(incidentSchema.safeParse({ ...incident, keys: [] }).success).toBe(true);
  });

  it('promover e anexar: de 1 a 50 alertas, sem repetir, e o responsável opcional', () => {
    const id = '018f2c1e-0000-7000-8000-0000000f0001';
    expect(incidentCreateSchema.safeParse({ findingIds: [id] }).success).toBe(true);
    expect(incidentCreateSchema.safeParse({ findingIds: [id], assigneeId: null }).success).toBe(true);
    expect(incidentCreateSchema.safeParse({ findingIds: [] }).success).toBe(false);
    expect(incidentCreateSchema.safeParse({ findingIds: [id, id] }).success).toBe(false);
    expect(incidentCreateSchema.safeParse({ findingIds: ['x'] }).success).toBe(false);
    expect(incidentCreateSchema.safeParse({ findingIds: [id], tenantId: id }).success).toBe(false);
    const many = Array.from(
      { length: 51 },
      (_, i) => `018f2c1e-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(incidentAttachSchema.safeParse({ findingIds: many }).success).toBe(false);
    expect(incidentAttachSchema.safeParse({ findingIds: many.slice(0, 50) }).success).toBe(true);
  });

  it('filtros: status, severidade e só os sem responsável', () => {
    expect(incidentListQuerySchema.parse({ status: 'open', unassigned: 'true' })).toMatchObject({
      status: 'open',
      unassigned: 'true',
    });
    expect(incidentListQuerySchema.safeParse({ unassigned: 'false' }).success).toBe(false);
  });

  it('atualização exige algum campo e aceita tirar o responsável', () => {
    expect(incidentUpdateSchema.safeParse({}).success).toBe(false);
    expect(incidentUpdateSchema.safeParse({ assigneeId: null }).success).toBe(true);
    expect(incidentUpdateSchema.safeParse({ status: 'resolved', assigneeId: 'u1' }).success).toBe(true);
  });
});
