import { describe, expect, it } from 'vitest';
import type { CloudWatchSourceOwner } from './cloudwatch-alert.js';
import {
  type AppliedObservation,
  CLOUDWATCH_OWNERSHIP_MARGIN_MS,
  CLOUDWATCH_OWNERSHIP_MAX_GAP_MS,
  CLOUDWATCH_OWNERSHIP_SETTLE_MS,
  type CloudWatchOwnership,
  cloudWatchProof,
  nextCloudWatchOwnership,
} from './cloudwatch-ownership.js';

/** Clientes e contas fictícios (IDs de exemplo da documentação da AWS). */
const A: CloudWatchSourceOwner = {
  tenantId: '018f2c1e-0000-7000-8000-00000000a1fa',
  accountId: '111122223333',
};
const B: CloudWatchSourceOwner = {
  tenantId: '018f2c1e-0000-7000-8000-00000000be7a',
  accountId: '444455556666',
};
/** Outra conta do cliente A. */
const A2: CloudWatchSourceOwner = { tenantId: A.tenantId, accountId: '777788889999' };

const G0 = '0'.repeat(64);
const G1 = '1'.repeat(64);
const G2 = '2'.repeat(64);
const UNKNOWN = 'f'.repeat(64);

const MINUTE = 60_000;
const T0 = new Date('2026-11-23T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);
/** O número de sequência do sinal do host na conferência do registro dos testes (o contador começa na hora dele). */
const SEQ = 1_795_000_000;
const ok = (generation: string, when: Date = T0, seq: number | null = SEQ): AppliedObservation => ({
  generation,
  status: 'ok',
  at: when.toISOString(),
  seq,
});
const failed = (
  generation: string | null,
  when: Date = T0,
  seq: number | null = SEQ,
): AppliedObservation => ({
  generation,
  status: 'error',
  at: when.toISOString(),
  seq,
});
const record = (overrides: Partial<CloudWatchOwnership> = {}): CloudWatchOwnership => ({
  owner: A,
  generation: G1,
  seq: SEQ,
  since: T0,
  confirmedAt: T0,
  ...overrides,
});

describe('prova do dono dos alertas do CloudWatch Logs: uma conferência da tarefa wazuh-config', () => {
  it('nasce só com a lista de agora aplicada (ok), com no máximo um dono', () => {
    const now = at(1);
    const observe = (applied: AppliedObservation | null, owners = [A]) =>
      nextCloudWatchOwnership(null, { now, generation: G1, owners, applied });
    // Sem o sinal, com o manager em outra lista, ou com a de agora dando erro: nada provado.
    expect(observe(null)).toBeNull();
    expect(observe(ok(G0))).toBeNull();
    expect(observe(failed(G1))).toBeNull();
    expect(observe(failed(null))).toBeNull();
    // A lista de agora aplicada: a prova começa nesta conferência.
    expect(observe(ok(G1))).toEqual({ owner: A, generation: G1, seq: SEQ, since: now, confirmedAt: now });
    // Sem grupo de logs na lista: a prova começa do mesmo jeito, sem dono.
    expect(observe(ok(G1), [])).toEqual({
      owner: null,
      generation: G1,
      seq: SEQ,
      since: now,
      confirmedAt: now,
    });
    // Mais de um dono (dois clientes, ou duas contas do mesmo cliente): nunca, nem com a lista aplicada.
    expect(observe(ok(G1), [A, B])).toBeNull();
    expect(observe(ok(G1), [A, A2])).toBeNull();
  });

  it('o começo nunca fica antes da hora do sinal do host (o relógio dele adiantado)', () => {
    const now = at(1);
    const ahead = at(4);
    expect(
      nextCloudWatchOwnership(null, { now, generation: G1, owners: [A], applied: ok(G1, ahead) }),
    ).toEqual({ owner: A, generation: G1, seq: SEQ, since: ahead, confirmedAt: now });
    // O sinal de antes desta conferência não puxa o começo para trás.
    expect(
      nextCloudWatchOwnership(null, { now, generation: G1, owners: [A], applied: ok(G1, at(-30)) }),
    ).toMatchObject({ since: now });
  });

  it('continua com o mesmo começo enquanto o manager roda uma geração conferida e o dono é o mesmo', () => {
    // A mesma lista, a conferência seguinte.
    expect(
      nextCloudWatchOwnership(record(), { now: at(1), generation: G1, owners: [A], applied: ok(G1) }),
    ).toEqual(record({ confirmedAt: at(1) }));
    // A lista mudou (outro grupo do mesmo dono) e o host ainda não a aplicou: o manager segue na conferida.
    const lagging = nextCloudWatchOwnership(record(), {
      now: at(1),
      generation: G2,
      owners: [A],
      applied: ok(G1),
    });
    expect(lagging).toEqual(record({ confirmedAt: at(1) }));
    // Aplicada a nova, numa troca só (o número seguinte): a geração e o número do registro acompanham, e o começo
    // não muda.
    expect(
      nextCloudWatchOwnership(lagging, {
        now: at(2),
        generation: G2,
        owners: [A],
        applied: ok(G2, at(2), SEQ + 1),
      }),
    ).toEqual(record({ generation: G2, seq: SEQ + 1, confirmedAt: at(2) }));
    // A lista nova que não muda a configuração do manager (só a região de um profile): o mesmo número, outra geração.
    expect(
      nextCloudWatchOwnership(lagging, { now: at(2), generation: G2, owners: [A], applied: ok(G2, at(2)) }),
    ).toEqual(record({ generation: G2, confirmedAt: at(2) }));
  });

  it('o dono vazio vira o primeiro dono que aparecer, sem recomeçar; e fica quando a lista fica sem grupos', () => {
    const empty = record({ owner: null, generation: G0 });
    // O primeiro grupo é autorizado: a lista planejada já tem dono, e o manager ainda roda a lista sem grupo nenhum.
    const adopted = nextCloudWatchOwnership(empty, {
      now: at(1),
      generation: G1,
      owners: [A],
      applied: ok(G0),
    });
    expect(adopted).toEqual({ owner: A, generation: G0, seq: SEQ, since: T0, confirmedAt: at(1) });
    // O dono tira todos os grupos: o registro segue dele (o que o manager ainda coleta é dele).
    const emptied = nextCloudWatchOwnership(record(), {
      now: at(1),
      generation: G2,
      owners: [],
      applied: ok(G1),
    });
    expect(emptied).toEqual(record({ confirmedAt: at(1) }));
    // E volta a autorizar: o mesmo começo.
    expect(
      nextCloudWatchOwnership(emptied, { now: at(2), generation: G1, owners: [A], applied: ok(G1) }),
    ).toEqual(record({ confirmedAt: at(2) }));
  });

  it('a lista planejada com grupos de mais de um dono derruba o registro na hora, antes de ser aplicada', () => {
    // O manager ainda roda a geração conferida, só com os grupos de A: não importa.
    for (const owners of [
      [A, B],
      [A, A2],
    ]) {
      expect(
        nextCloudWatchOwnership(record(), { now: at(1), generation: G2, owners, applied: ok(G1) }),
      ).toBeNull();
    }
  });

  it('outro dono recomeça: nada do começo do anterior passa para ele', () => {
    // Só B na lista planejada, e o manager ainda na lista de A.
    expect(
      nextCloudWatchOwnership(record(), { now: at(1), generation: G2, owners: [B], applied: ok(G1) }),
    ).toBeNull();
    // A lista de B aplicada: outro registro, com o começo de agora.
    expect(
      nextCloudWatchOwnership(record(), {
        now: at(5),
        generation: G2,
        owners: [B],
        applied: ok(G2, at(4), SEQ + 1),
      }),
    ).toEqual({ owner: B, generation: G2, seq: SEQ + 1, since: at(5), confirmedAt: at(5) });
    // A passou pela lista vazia antes (A tira os grupos, B autoriza depois): o registro ainda é de A, e recomeça.
    const emptied = record({ generation: G0 });
    expect(
      nextCloudWatchOwnership(emptied, { now: at(1), generation: G2, owners: [B], applied: ok(G0) }),
    ).toBeNull();
    // Outra conta do mesmo cliente também é outro dono.
    expect(
      nextCloudWatchOwnership(record(), { now: at(1), generation: G2, owners: [A2], applied: ok(G1) }),
    ).toBeNull();
  });

  it('sem o sinal, ou com o manager numa geração que a tarefa não conferiu, o registro cai', () => {
    const observe = (applied: AppliedObservation | null) =>
      nextCloudWatchOwnership(record(), { now: at(1), generation: G2, owners: [A], applied });
    expect(observe(null)).toBeNull();
    // O host aplicou (ou tentou aplicar) uma lista que o worker não planejou.
    expect(observe(ok(UNKNOWN))).toBeNull();
    expect(observe(failed(UNKNOWN))).toBeNull();
    // A tentativa que nem chegou ao gerador não mexeu no manager; a de uma geração conferida que deu erro sem troca
    // nenhuma (o gerador a recusou, ou é a que já tinha derrubado o manager) também não.
    expect(observe(failed(null))).toEqual(record({ confirmedAt: at(1) }));
    expect(observe(failed(G2))).toEqual(record({ confirmedAt: at(1) }));
    expect(observe(failed(G1))).toEqual(record({ confirmedAt: at(1) }));
  });

  it('o número de sequência: o mesmo, ou o seguinte com ok e uma geração conferida; qualquer outro salto derruba', () => {
    const observe = (applied: AppliedObservation, generation = G2) =>
      nextCloudWatchOwnership(record(), { now: at(1), generation, owners: [A], applied });
    // Uma troca só, para a lista planejada: continua, e o registro passa a guardar o número novo.
    expect(observe(ok(G2, T0, SEQ + 1))).toEqual(
      record({ generation: G2, seq: SEQ + 1, confirmedAt: at(1) }),
    );
    // Uma troca só, para uma lista que a tarefa não conferiu: cai.
    expect(observe(ok(UNKNOWN, T0, SEQ + 1))).toBeNull();

    // Duas trocas entre duas conferências: a do meio pode ter sido de uma lista que a tarefa nunca planejou. Mesmo
    // com o manager agora na geração do registro, a continuidade se perdeu: ele cai e, com outra lista planejada,
    // não nasce.
    expect(observe(ok(G1, T0, SEQ + 2))).toBeNull();
    // Com a lista de agora aplicada, nasce outro, com o começo de agora: nada de antes do salto fica provado.
    expect(observe(ok(G2, at(1), SEQ + 2))).toEqual({
      owner: A,
      generation: G2,
      seq: SEQ + 2,
      since: at(1),
      confirmedAt: at(1),
    });
    expect(observe(ok(G2, at(1), SEQ + 40))).toMatchObject({ seq: SEQ + 40, since: at(1) });
    // O contador que voltou (o arquivo do host apagado, um disco restaurado) também é um salto.
    expect(observe(ok(G1, T0, SEQ - 1), G1)).toMatchObject({ seq: SEQ - 1, since: at(1) });
    expect(observe(ok(G1, T0, 0), G1)).toMatchObject({ seq: 0, since: at(1) });
    expect(observe(ok(G1, T0, SEQ - 1))).toBeNull();
  });

  it('a troca com erro nunca é prova: a tentativa que derrubou o manager e voltou conta duas trocas', () => {
    const observe = (applied: AppliedObservation) =>
      nextCloudWatchOwnership(record(), { now: at(1), generation: G2, owners: [A], applied });
    // O host reiniciou o manager com a lista nova, ele não ficou saudável e a anterior voltou: duas trocas, com erro.
    // Mesmo com a geração conferida, o registro cai (outra aplicação pode ter passado entre as duas conferências), e
    // um registro nunca nasce de um erro.
    expect(observe(failed(G2, T0, SEQ + 2))).toBeNull();
    // Uma troca e o sinal com erro: o erro é da última tentativa, e não diz o que a troca deixou no manager.
    expect(observe(failed(G2, T0, SEQ + 1))).toBeNull();
    expect(observe(failed(null, T0, SEQ + 1))).toBeNull();
    expect(observe(failed(UNKNOWN, T0, SEQ + 1))).toBeNull();
    // Depois da volta, a lista planejada aplicada com sucesso faz o registro nascer de novo, com outro começo.
    expect(
      nextCloudWatchOwnership(null, {
        now: at(9),
        generation: G2,
        owners: [A],
        applied: ok(G2, at(8), SEQ + 3),
      }),
    ).toEqual({ owner: A, generation: G2, seq: SEQ + 3, since: at(9), confirmedAt: at(9) });
  });

  it('o sinal sem o número de sequência (o host de uma versão anterior) nunca é prova: nem nasce, nem continua', () => {
    // O registro que existia cai, mesmo com a geração conferida e sem erro.
    expect(
      nextCloudWatchOwnership(record(), {
        now: at(1),
        generation: G1,
        owners: [A],
        applied: ok(G1, T0, null),
      }),
    ).toBeNull();
    expect(
      nextCloudWatchOwnership(record(), {
        now: at(1),
        generation: G1,
        owners: [A],
        applied: failed(null, T0, null),
      }),
    ).toBeNull();
    // E nenhum nasce, com ou sem grupo de logs na lista.
    for (const owners of [[A], []]) {
      expect(
        nextCloudWatchOwnership(null, { now: at(1), generation: G1, owners, applied: ok(G1, T0, null) }),
      ).toBeNull();
    }
  });

  it('mais de 5 min sem conferir: o registro recomeça (o worker parado não viu o que o host aplicou)', () => {
    const gap = CLOUDWATCH_OWNERSHIP_MAX_GAP_MS;
    const onTime = new Date(T0.getTime() + gap);
    expect(
      nextCloudWatchOwnership(record(), { now: onTime, generation: G1, owners: [A], applied: ok(G1) }),
    ).toEqual(record({ confirmedAt: onTime }));
    const late = new Date(T0.getTime() + gap + 1);
    // Com a lista de agora aplicada, nasce outro, com o começo de agora; sem isso, nenhum.
    expect(
      nextCloudWatchOwnership(record(), { now: late, generation: G1, owners: [A], applied: ok(G1) }),
    ).toEqual({ owner: A, generation: G1, seq: SEQ, since: late, confirmedAt: late });
    expect(
      nextCloudWatchOwnership(record(), { now: late, generation: G2, owners: [A], applied: ok(G1) }),
    ).toBeNull();
  });
});

describe('prova do dono dos alertas do CloudWatch Logs: o intervalo em que o sync atribui', () => {
  it('do começo mais a margem de 15 min até a última conferência menos a espera de 10 min', () => {
    expect(CLOUDWATCH_OWNERSHIP_MARGIN_MS).toBe(15 * MINUTE);
    expect(CLOUDWATCH_OWNERSHIP_SETTLE_MS).toBe(10 * MINUTE);
    expect(CLOUDWATCH_OWNERSHIP_MAX_GAP_MS).toBe(5 * MINUTE);
    const proven = record({ since: T0, confirmedAt: at(60) });
    expect(cloudWatchProof(proven, A, at(60))).toEqual({ from: at(15), until: at(50), live: true });
    // A tarefa parada há mais de 5 min: o que já estava assentado segue provado, e o resto não tem por que esperar.
    expect(cloudWatchProof(proven, A, at(65))).toMatchObject({ until: at(50), live: true });
    expect(cloudWatchProof(proven, A, at(66))).toMatchObject({ until: at(50), live: false });
  });

  it('sem registro, sem dono no registro, ou com o registro de outro dono: sem prova', () => {
    expect(cloudWatchProof(null, A, at(60))).toBeNull();
    expect(cloudWatchProof(record({ owner: null }), A, at(60))).toBeNull();
    expect(cloudWatchProof(record({ owner: B }), A, at(60))).toBeNull();
    // A mesma conta em outro cliente, e outra conta do mesmo cliente.
    expect(cloudWatchProof(record({ owner: { ...A, tenantId: B.tenantId } }), A, at(60))).toBeNull();
    expect(cloudWatchProof(record({ owner: A2 }), A, at(60))).toBeNull();
  });
});
