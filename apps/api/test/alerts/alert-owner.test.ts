import { describe, expect, it } from 'vitest';
import {
  AccountDirectory,
  resolveAlertOwner,
  type AlertOwner,
  type RegisteredAwsAccount,
} from '../../src/alerts/alert-owner.js';
import { parseWazuhAlert } from '../../src/alerts/wazuh-alert.js';
import {
  ALFA,
  BETA,
  UNREGISTERED_ACCOUNT,
  cloudTrailAlert,
  guardDutyAlert,
  wafAlert,
  withAws,
} from './fixtures.js';

function ownerOf(
  document: Record<string, unknown>,
  accounts: RegisteredAwsAccount[] = [ALFA, BETA],
): AlertOwner {
  const parsed = parseWazuhAlert(document);
  if (!parsed.ok) throw new Error(`fixture inválida: ${parsed.reason}`);
  return resolveAlertOwner(parsed.alert, AccountDirectory.from(accounts));
}

const owned = (account: RegisteredAwsAccount): AlertOwner => ({
  owned: true,
  tenantId: account.tenantId,
  accountId: account.accountId,
});

describe('vínculo entre alerta e cliente (T5.2)', () => {
  it('atribui cada fonte ao cliente certo, com contas de dois clientes', () => {
    expect(ownerOf(cloudTrailAlert())).toEqual(owned(ALFA));
    expect(ownerOf(cloudTrailAlert({ account: BETA.accountId, bucket: 'trilha-beta' }))).toEqual(owned(BETA));
    expect(ownerOf(guardDutyAlert())).toEqual(owned(ALFA));
    expect(ownerOf(wafAlert())).toEqual(owned(ALFA));
    expect(ownerOf(wafAlert({ account: BETA.accountId, bucket: 'aws-waf-logs-beta' }))).toEqual(owned(BETA));
  });

  it('evento forjado com a conta de outro cliente vai para a fila sem dono', () => {
    // O cliente Alfa controla o próprio bucket e escreve ali um evento com a conta do Beta.
    const forged = [
      guardDutyAlert({ account: BETA.accountId, bucket: 'guardduty-alfa' }),
      wafAlert({ account: BETA.accountId, bucket: 'aws-waf-logs-alfa' }),
      cloudTrailAlert({ account: BETA.accountId, bucket: 'trilha-alfa' }),
    ];
    for (const alert of forged) {
      expect(ownerOf(alert)).toEqual({ owned: false, reason: 'source_mismatch', accounts: [BETA.accountId] });
    }
  });

  it('bucket de origem não cadastrado para a fonte: sem dono, mesmo com conta válida', () => {
    expect(ownerOf(cloudTrailAlert({ bucket: 'trilha-desconhecida' }))).toMatchObject({
      owned: false,
      reason: 'unknown_source',
    });
    // O bucket do GuardDuty do Alfa não vale como origem de CloudTrail.
    expect(ownerOf(cloudTrailAlert({ bucket: 'guardduty-alfa' }))).toMatchObject({
      reason: 'unknown_source',
    });
  });

  it('conta não cadastrada: sem dono', () => {
    expect(ownerOf(guardDutyAlert({ account: UNREGISTERED_ACCOUNT }))).toEqual({
      owned: false,
      reason: 'unknown_account',
      accounts: [UNREGISTERED_ACCOUNT],
    });
  });

  it('contas diferentes no mesmo evento: sem dono', () => {
    expect(ownerOf(cloudTrailAlert({ recipient: BETA.accountId }))).toEqual({
      owned: false,
      reason: 'conflicting_accounts',
      accounts: [ALFA.accountId, BETA.accountId],
    });
    expect(ownerOf(guardDutyAlert({ arnAccount: BETA.accountId }))).toMatchObject({
      reason: 'conflicting_accounts',
    });
  });

  it('evento sem conta: sem dono', () => {
    expect(ownerOf(wafAlert({ webaclId: null }))).toEqual({
      owned: false,
      reason: 'no_account',
      accounts: [],
    });
  });

  it('campo de conta fora do formato invalida o alerta em vez de sobrar outro campo', () => {
    const invalid = [
      withAws(guardDutyAlert(), { accountId: '11112222333x' }),
      withAws(guardDutyAlert(), { arn: 'arn:aws:s3:::guardduty-alfa' }),
      withAws(cloudTrailAlert(), { recipientAccountId: 111122223333 }),
      wafAlert({ webaclId: 'arn:aws:s3:sa-east-1:111122223333:regional/webacl/painel/0000' }),
      wafAlert({ webaclId: 'nao-e-arn' }),
    ];
    for (const alert of invalid) {
      expect(ownerOf(alert)).toEqual({ owned: false, reason: 'invalid_alert', accounts: [] });
    }
  });

  it('o mesmo bucket cadastrado por dois clientes não vale para nenhum', () => {
    const intruder: RegisteredAwsAccount = {
      tenantId: BETA.tenantId,
      accountId: '555566667777',
      buckets: { guardduty: 'guardduty-alfa' },
    };
    expect(ownerOf(guardDutyAlert(), [ALFA, BETA, intruder])).toMatchObject({ reason: 'ambiguous_source' });
    expect(ownerOf(guardDutyAlert({ account: '555566667777' }), [ALFA, BETA, intruder])).toMatchObject({
      reason: 'ambiguous_source',
    });
  });

  it('a mesma conta em dois clientes não vale para nenhum', () => {
    const duplicate: RegisteredAwsAccount = { ...ALFA, tenantId: BETA.tenantId, buckets: {} };
    expect(ownerOf(guardDutyAlert(), [ALFA, BETA, duplicate])).toMatchObject({ reason: 'unknown_account' });
  });

  it('trilha da organização: contas do mesmo cliente que cadastraram o mesmo bucket', () => {
    const member: RegisteredAwsAccount = {
      tenantId: ALFA.tenantId,
      accountId: '222233334444',
      buckets: { cloudtrail: 'trilha-alfa' },
    };
    const other: RegisteredAwsAccount = {
      tenantId: ALFA.tenantId,
      accountId: '333344445555',
      buckets: { cloudtrail: 'trilha-propria' },
    };
    const accounts = [ALFA, member, other, BETA];
    expect(ownerOf(cloudTrailAlert(), accounts)).toEqual(owned(ALFA));
    expect(ownerOf(cloudTrailAlert({ account: member.accountId }), accounts)).toEqual(owned(member));
    // Pasta de uma conta do mesmo cliente que não cadastrou este bucket: o Wazuh não leria essa pasta.
    expect(ownerOf(cloudTrailAlert({ account: other.accountId }), accounts)).toMatchObject({
      reason: 'source_mismatch',
    });
  });

  it('GuardDuty com administrador delegado: achado de outra conta do mesmo cliente', () => {
    const member: RegisteredAwsAccount = { tenantId: ALFA.tenantId, accountId: '222233334444', buckets: {} };
    expect(ownerOf(guardDutyAlert({ account: member.accountId }), [ALFA, member, BETA])).toEqual(
      owned(member),
    );
  });
});
