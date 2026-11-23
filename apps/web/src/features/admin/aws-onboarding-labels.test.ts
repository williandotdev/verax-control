import {
  AWS_COLLECTION_ERROR_CODES,
  AWS_CONNECTION_ERROR_CODES,
  AWS_CONNECTION_WARNING_CODES,
  AWS_DISCOVERY_SERVICES,
  AWS_DISCOVERY_STATUSES,
  AWS_LOG_GROUP_CATEGORIES,
  AWS_ONBOARDING_CHECK_CODES,
  AWS_ONBOARDING_CHECK_IDS,
  AWS_ONBOARDING_CHECK_STATUSES,
  AWS_ONBOARDING_ERROR_CODES,
  AWS_ONBOARDING_STATES,
  AWS_READER_AUTHORIZATIONS,
  AWS_READER_PREFILL_PROBLEMS,
  AWS_SOURCE_AVAILABILITIES,
  AWS_SOURCE_KINDS,
  AWS_SOURCE_LOGGING_STATES,
  AWS_SOURCE_NOTES,
  AWS_SOURCE_PERMISSION_CODES,
  AWS_SOURCE_STATE_CODES,
  AWS_SOURCE_STATES,
  type AwsOnboardingCheck,
  awsInfrastructureSummarySchema,
  CONSOLE_MANAGED_CODE,
  isAwsRegion,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import { authorizedSourceFixture, sourceFixture } from '@/test/aws-onboarding-fixtures';
import {
  AWS_AUTHORIZATION_FOOTNOTE,
  AWS_AUTHORIZATION_TEXTS,
  AWS_CHECK_CODE_TEXTS,
  AWS_CHECK_LABELS,
  AWS_CHECK_STATUS_LABELS,
  AWS_CHECK_STATUS_TONES,
  AWS_DEFAULT_REGION,
  AWS_DISCOVERY_SERVICE_LABELS,
  AWS_DISCOVERY_STATUS_LABELS,
  AWS_INFRASTRUCTURE_LABELS,
  AWS_INGESTION_ERROR_CODES,
  AWS_LOG_GROUP_CATEGORY_LABELS,
  AWS_ONBOARDING_ERROR_TEXTS,
  AWS_ONBOARDING_STATE_STEP,
  AWS_ONBOARDING_STATE_TEXTS,
  AWS_ONBOARDING_STEP_LABELS,
  AWS_ONBOARDING_STEPS,
  AWS_PREFILL_PROBLEM_TEXTS,
  AWS_REGION_OPTIONS,
  AWS_SOURCE_AVAILABILITY_TEXTS,
  AWS_SOURCE_KIND_TEXTS,
  AWS_SOURCE_LOGGING_STATE_LABELS,
  AWS_SOURCE_NOTE_TEXTS,
  AWS_SOURCE_PERMISSION_CODE_TEXTS,
  AWS_SOURCE_STATE_CODE_TEXTS,
  AWS_SOURCE_STATE_TEXTS,
  awsCheckLabel,
  awsCheckText,
  awsDiscoveryErrorHint,
  awsIngestionErrorText,
  awsOnboardingErrorText,
  awsOnboardingStateText,
  awsPermissionDetailText,
  awsSourceHealthText,
  awsSourceName,
  isAwsCostNote,
} from './aws-onboarding-labels';

/** Todo valor do catálogo tem um texto não vazio no mapa (o TypeScript já exige a chave; aqui, o conteúdo). */
function expectTexts(catalogue: readonly string[], texts: Readonly<Record<string, unknown>>): void {
  expect(Object.keys(texts).sort()).toEqual([...catalogue].sort());
  for (const key of catalogue) {
    const value = texts[key];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    expect(text.length, key).toBeGreaterThan(1);
  }
}

const check = (
  id: AwsOnboardingCheck['id'],
  status: AwsOnboardingCheck['status'],
  code: string | null = null,
): AwsOnboardingCheck => ({ id, status, code, checkedAt: null });

describe('textos do onboarding da AWS: todo código do contrato tem o texto dele', () => {
  it('estados da conta: rótulo, explicação e tom; o passo de cada um', () => {
    expectTexts(AWS_ONBOARDING_STATES, AWS_ONBOARDING_STATE_TEXTS);
    expectTexts(AWS_ONBOARDING_STEPS, AWS_ONBOARDING_STEP_LABELS);
    expect(Object.keys(AWS_ONBOARDING_STATE_STEP).sort()).toEqual([...AWS_ONBOARDING_STATES].sort());
    for (const state of AWS_ONBOARDING_STATES) {
      const text = AWS_ONBOARDING_STATE_TEXTS[state];
      expect(text.label).toBeTruthy();
      expect(text.description).toMatch(/\.$/);
      const step = AWS_ONBOARDING_STATE_STEP[state];
      if (step !== null) expect(AWS_ONBOARDING_STEPS).toContain(step.step);
    }
    // Os nomes que a tela mostra em cada passo do acompanhamento.
    expect(AWS_ONBOARDING_STATE_TEXTS.awaiting_authorization.label).toBe('Aguardando autorização na AWS');
    expect(AWS_ONBOARDING_STATE_TEXTS.authenticated.label).toBe('Autenticação validada');
    expect(AWS_ONBOARDING_STATE_TEXTS.discovering.label).toBe('Descoberta em andamento');
    expect(AWS_ONBOARDING_STATE_TEXTS.awaiting_sources.label).toBe('Aguardando autorização de fontes');
    expect(AWS_ONBOARDING_STATE_TEXTS.configuring.label).toBe('Configurando coletores');
    expect(AWS_ONBOARDING_STATE_TEXTS.collecting.label).toBe('Coletando eventos');
    expect(AWS_ONBOARDING_STATE_TEXTS.partial.label).toBe('Parcialmente operacional');
    expect(AWS_ONBOARDING_STATE_TEXTS.permission_error.label).toBe('Erro de permissão');
    expect(AWS_ONBOARDING_STATE_TEXTS.ingestion_failure.label).toBe('Falha de ingestão');
    expect(AWS_ONBOARDING_STATE_TEXTS.disconnected.label).toBe('Desconectada');
    expect(AWS_ONBOARDING_STATE_TEXTS.authorization_timeout.label).toBe('Tempo esgotado');
    // Só "coletando" tem o tom de tudo certo; a espera diz que o Verax não enxerga a pilha.
    const ok = AWS_ONBOARDING_STATES.filter((state) => AWS_ONBOARDING_STATE_TEXTS[state].tone === 'ok');
    expect(ok).toEqual(['collecting']);
    expect(AWS_ONBOARDING_STATE_TEXTS.awaiting_authorization.description).toMatch(/não enxerga a pilha/);
  });

  it('na VM própria do cliente, a espera e a recusa falam da chave, não da pilha', () => {
    expect(awsOnboardingStateText('awaiting_authorization', 'access_key').description).toMatch(/chave/);
    expect(awsOnboardingStateText('awaiting_authorization', 'access_key').description).not.toMatch(/pilha/);
    expect(awsOnboardingStateText('disconnected', 'access_key').description).toMatch(/chave/);
    expect(awsOnboardingStateText('collecting', 'access_key')).toEqual(AWS_ONBOARDING_STATE_TEXTS.collecting);
    expect(awsCheckLabel('assume_role', 'access_key')).toMatch(/chave/);
    expect(awsCheckLabel('events', 'access_key')).toBe(AWS_CHECK_LABELS.events);
  });

  it('conferências: nome, situação e motivo próprio', () => {
    expectTexts(AWS_ONBOARDING_CHECK_IDS, AWS_CHECK_LABELS);
    expectTexts(AWS_ONBOARDING_CHECK_STATUSES, AWS_CHECK_STATUS_LABELS);
    expectTexts(AWS_ONBOARDING_CHECK_STATUSES, AWS_CHECK_STATUS_TONES);
    expectTexts(AWS_ONBOARDING_CHECK_CODES, AWS_CHECK_CODE_TEXTS);
  });

  it('toda conferência tem texto em toda situação, e o motivo nunca vira a mensagem crua', () => {
    for (const id of AWS_ONBOARDING_CHECK_IDS) {
      for (const status of AWS_ONBOARDING_CHECK_STATUSES) {
        expect(awsCheckText(check(id, status)).text, `${id}/${status}`).toMatch(/\.$/);
        // Um código que a tela não conhece aparece como tipo do erro, não some nem quebra.
        expect(awsCheckText(check(id, status, 'CodigoDesconhecido')).text, `${id}/${status}`).toBeTruthy();
      }
    }
  });

  it('entrada no papel: cada código da conexão tem a explicação dele e o "tentar de novo" certo', () => {
    for (const code of AWS_CONNECTION_ERROR_CODES) {
      const { text, action } = awsCheckText(check('assume_role', 'failed', code));
      expect(text, code).not.toMatch(/Tipo do erro/);
      expect(action, code).toBe(code === 'authorization_timeout' ? 'connect' : 'verify');
    }
    expect(awsCheckText(check('assume_role', 'failed', 'trust_denied')).text).toMatch(
      /^A AWS recusou a entrada no papel/,
    );
    expect(awsCheckText(check('assume_role', 'failed', 'authorization_timeout')).text).toMatch(/60 minutos/);
    expect(awsCheckText(check('assume_role', 'failed', 'ErroNovo')).text).toMatch(
      /Tipo do erro: ErroNovo\.$/,
    );
    expect(awsCheckText(check('assume_role', 'pending', 'awaiting_stack')).text).toMatch(
      /Aguardando a pilha/,
    );
    expect(awsCheckText(check('assume_role', 'pending', 'verifying')).text).toMatch(/Verificação pedida/);
    expect(awsCheckText(check('assume_role', 'pending', 'not_requested')).text).toBe('Ainda não foi pedida.');
    // Conectada com aviso: a entrada vale, e o aviso diz o que conferir.
    for (const code of AWS_CONNECTION_WARNING_CODES) {
      expect(awsCheckText(check('assume_role', 'ok', code)).text, code).toMatch(/Aviso: /);
    }
    expect(awsCheckText(check('assume_role', 'ok')).text).not.toMatch(/Aviso/);
    expect(awsCheckText(check('identity', 'failed', 'account_mismatch'))).toEqual({
      text: 'O papel respondeu de outra conta AWS. Confira o ID da conta cadastrada.',
      action: 'verify',
    });
  });

  it('modelo, descoberta, permissão, coletores, eventos e atraso: o texto pelo código', () => {
    expect(awsCheckText(check('template', 'failed', 'template_outdated')).text).toMatch(/modelo anterior/);
    expect(awsCheckText(check('template', 'failed', 'template_unreadable')).text).toMatch(
      /verax-control:template/,
    );
    expect(awsCheckText(check('discovery', 'ok', 'partial'))).toMatchObject({
      text: expect.stringMatching(/sem conseguir ler tudo/) as string,
      action: 'discover',
    });
    expect(awsCheckText(check('discovery', 'ok')).action).toBeNull();
    expect(awsCheckText(check('discovery', 'pending', 'running')).text).toBe(
      'A descoberta está em andamento.',
    );
    expect(awsCheckText(check('discovery', 'pending', 'pending')).text).toMatch(/na fila/);
    expect(awsCheckText(check('discovery', 'pending', 'not_requested')).action).toBe('discover');
    expect(awsCheckText(check('discovery', 'failed', 'interrupted'))).toMatchObject({
      text: expect.stringMatching(/interrompida/) as string,
      action: 'discover',
    });
    for (const code of AWS_SOURCE_PERMISSION_CODES) {
      expect(awsCheckText(check('permission', 'failed', code)).text, code).toContain(
        AWS_SOURCE_PERMISSION_CODE_TEXTS[code],
      );
    }
    expect(awsCheckText(check('permission', 'failed', 'guardduty:ListFindings')).text).toMatch(
      /a AWS negou a ação guardduty:ListFindings/,
    );
    for (const code of AWS_COLLECTION_ERROR_CODES) {
      expect(awsCheckText(check('collector_config', 'failed', code)).text, code).toMatch(/fale com a Verax/);
    }
    expect(awsCheckText(check('collector_config', 'pending', 'awaiting_collector')).text).toMatch(
      /Aguardando o coletor iniciar/,
    );
    expect(awsCheckText(check('events', 'pending', 'waiting_events')).text).toMatch(
      /ainda não chegou evento/,
    );
    expect(awsCheckText(check('events', 'pending', 'awaiting_collector')).text).toMatch(
      /Aguardando o coletor/,
    );
    expect(awsCheckText(check('events', 'failed', 'stalled')).text).toMatch(/parou de entregar/);
    // A falha de leitura: o limite de requisições e os erros conhecidos têm o texto deles; o resto, o tipo do erro.
    expect(awsCheckText(check('events', 'failed', 'throttled')).text).toMatch(
      /A AWS está limitando as chamadas a este serviço\. O Verax tenta de novo sozinho.*Veja qual fonte/,
    );
    expect(awsCheckText(check('events', 'failed', 'TimeoutError')).text).toMatch(/não respondeu a tempo/);
    expect(awsCheckText(check('events', 'failed', 'parse_error')).text).toMatch(
      /Tipo do erro: parse_error\. Veja qual fonte em "Fontes autorizadas"\.$/,
    );
    expect(awsCheckText(check('last_sync', 'pending', 'no_data')).text).toMatch(/Ainda não há leitura/);
    expect(awsCheckText(check('lag', 'failed', 'stalled')).text).toMatch(/mais de 2 horas de atraso/);
    // A fonte de achados atrasada não está "parada": o que atrasou foi a leitura.
    expect(awsCheckText(check('lag', 'failed', 'sync_delayed')).text).toMatch(
      /fonte de achados está há mais de 2 horas sem uma leitura que dê certo/,
    );
    expect(awsCheckText(check('lag', 'failed', 'sync_delayed')).text).not.toMatch(/Tipo do erro/);
    expect(awsCheckText(check('lag', 'pending', 'no_data')).text).toMatch(/Ainda não há medida/);
    // A autorização desligada na pilha também chega como motivo da permissão de uma fonte autorizada.
    expect(awsCheckText(check('permission', 'failed', 'capability_off')).text).toMatch(
      /a autorização deste tipo de fonte está desligada na pilha/,
    );
  });

  it('falha de leitura de uma fonte: o limite de requisições, os erros conhecidos e o tipo do erro como reserva', () => {
    for (const code of AWS_INGESTION_ERROR_CODES) {
      const text = awsIngestionErrorText(code);
      expect(text, code).toMatch(/sozinho/);
      expect(text, code).not.toMatch(/Tipo do erro/);
    }
    expect(AWS_INGESTION_ERROR_CODES).toEqual(
      expect.arrayContaining(['throttled', 'TimeoutError', 'Unknown', 'InternalServerException']),
    );
    expect(awsIngestionErrorText('throttled')).toBe(AWS_SOURCE_STATE_CODE_TEXTS.throttled);
    expect(awsIngestionErrorText('throttled')).toMatch(/não é preciso fazer nada/);
    expect(awsIngestionErrorText('ErroNovoDaAws')).toMatch(/Tipo do erro: ErroNovoDaAws\.$/);
    // Um nome de propriedade de objeto não vira texto estranho.
    expect(awsIngestionErrorText('toString')).toMatch(/Tipo do erro: toString\.$/);
    expect(awsIngestionErrorText(null)).toMatch(/falhou nas últimas tentativas/);
  });

  it('descoberta: serviços, resultados e o motivo do que ficou de fora', () => {
    expectTexts(AWS_DISCOVERY_SERVICES, AWS_DISCOVERY_SERVICE_LABELS);
    expectTexts(AWS_DISCOVERY_STATUSES, AWS_DISCOVERY_STATUS_LABELS);
    expect(awsDiscoveryErrorHint('AccessDeniedException')).toMatch(/sem permissão/);
    expect(awsDiscoveryErrorHint('UnauthorizedOperation')).toMatch(/sem permissão/);
    expect(awsDiscoveryErrorHint('TimeoutError')).toMatch(/não respondeu a tempo/);
    expect(awsDiscoveryErrorHint('Truncated')).toMatch(/incompleta/);
    expect(awsDiscoveryErrorHint('OptInRequired')).toMatch(/região não está habilitada/);
    // O nome de um erro desconhecido aparece como veio; um nome de propriedade de objeto não vira texto estranho.
    expect(awsDiscoveryErrorHint('ErroNovoDaAws')).toBe('a AWS respondeu ErroNovoDaAws');
    expect(awsDiscoveryErrorHint('toString')).toBe('a AWS respondeu toString');
  });

  it('fontes: tipos, estados, motivos, disponibilidade, notas e categorias dos grupos', () => {
    expectTexts(AWS_SOURCE_KINDS, AWS_SOURCE_KIND_TEXTS);
    expectTexts(AWS_SOURCE_STATES, AWS_SOURCE_STATE_TEXTS);
    expectTexts(AWS_SOURCE_STATE_CODES, AWS_SOURCE_STATE_CODE_TEXTS);
    expectTexts(AWS_SOURCE_AVAILABILITIES, AWS_SOURCE_AVAILABILITY_TEXTS);
    expectTexts(AWS_SOURCE_LOGGING_STATES, AWS_SOURCE_LOGGING_STATE_LABELS);
    expectTexts(AWS_SOURCE_PERMISSION_CODES, AWS_SOURCE_PERMISSION_CODE_TEXTS);
    expectTexts(AWS_SOURCE_NOTES, AWS_SOURCE_NOTE_TEXTS);
    expectTexts(AWS_LOG_GROUP_CATEGORIES, AWS_LOG_GROUP_CATEGORY_LABELS);
    // As notas de custo são as que começam com `aws_cost_`, e todas dizem que o custo é na AWS.
    for (const note of AWS_SOURCE_NOTES) {
      expect(isAwsCostNote(note), note).toBe(note.startsWith('aws_cost_'));
      if (isAwsCostNote(note)) expect(AWS_SOURCE_NOTE_TEXTS[note]).toMatch(/custo na AWS/);
    }
    expect(AWS_SOURCE_NOTE_TEXTS.high_volume).toMatch(/volume mensal do seu plano/);
    expect(AWS_SOURCE_NOTE_TEXTS.covered_by_api).toMatch(/^Coberto pela API/);
    expect(awsPermissionDetailText(null)).toMatch(/ainda não foi conferida/);
    expect(awsPermissionDetailText('tag_missing')).toMatch(/etiqueta verax-control = leitura/);
    expect(awsPermissionDetailText('logs:GetLogEvents')).toBe('a AWS negou a ação logs:GetLogEvents');
    // A linha de um serviço desligado tem o tipo como nome: a tela mostra só o rótulo do tipo.
    expect(awsSourceName({ kind: 'inspector', name: 'inspector' })).toBe('');
    expect(awsSourceName({ kind: 'cloudtrail', name: 'management-events' })).toBe('management-events');
  });

  it('saúde da fonte autorizada: textos honestos para cada estado', () => {
    expect(awsSourceHealthText(authorizedSourceFixture('cloudtrail', 'authorized'))).toMatchObject({
      label: 'Aguardando o coletor iniciar',
      detail: null,
    });
    expect(awsSourceHealthText(authorizedSourceFixture('cloudtrail', 'configuring')).label).toBe(
      'Configurando o coletor',
    );
    expect(awsSourceHealthText(authorizedSourceFixture('cloudtrail', 'waiting_events')).label).toBe(
      'Configurada, ainda sem eventos',
    );
    expect(awsSourceHealthText(authorizedSourceFixture('cloudtrail', 'collecting')).label).toBe('Coletando');
    // Fonte de achados sem achado novo: sincronizada, sem fingir evento. Com achado, coletando.
    const quiet = authorizedSourceFixture('guardduty', 'collecting', {
      health: {
        lastSyncAt: '2026-11-23T11:59:00.000Z',
        lastEventAt: null,
        lastIngestedAt: null,
        lagSeconds: 30,
        eventsLast24h: 0,
        bytesLast24h: 0,
      },
    });
    expect(awsSourceHealthText(quiet)).toMatchObject({
      label: 'Sincronizada, sem achados novos',
      tone: 'ok',
    });
    expect(awsSourceHealthText({ ...quiet, health: { ...quiet.health, eventsLast24h: 4 } }).label).toBe(
      'Coletando',
    );
    // O código do coletor de achados diz isso sem depender do volume: a fonte nunca trouxe um achado.
    expect(
      awsSourceHealthText(
        authorizedSourceFixture('security_hub', 'collecting', {
          stateCode: 'no_findings_yet',
          health: { ...quiet.health, eventsLast24h: null },
        }),
      ),
    ).toEqual({
      label: 'Sincronizada, sem achados novos',
      tone: 'ok',
      detail: AWS_SOURCE_STATE_CODE_TEXTS.no_findings_yet,
    });
    // Uma trilha coletando sem evento medido continua "coletando": só as de achados têm a frase própria.
    expect(awsSourceHealthText({ ...quiet, kind: 'cloudtrail' }).label).toBe('Coletando');
    expect(awsSourceHealthText(authorizedSourceFixture('vpc_flow_logs', 'stalled')).detail).toMatch(
      /parou de entregar/,
    );
    expect(
      awsSourceHealthText(
        authorizedSourceFixture('waf', 'permission_error', {
          permission: 'missing',
          permissionDetail: 'kms_denied',
        }),
      ).detail,
    ).toMatch(/Falta permissão: a chave KMS/);
    expect(
      awsSourceHealthText(authorizedSourceFixture('waf', 'ingestion_error', { stateCode: 'parse_error' }))
        .detail,
    ).toMatch(/Tipo do erro: parse_error\.$/);
    expect(
      awsSourceHealthText(
        authorizedSourceFixture('security_hub', 'ingestion_error', { stateCode: 'throttled' }),
      ).detail,
    ).toBe(AWS_SOURCE_STATE_CODE_TEXTS.throttled);
    expect(
      awsSourceHealthText(authorizedSourceFixture('waf', 'source_missing', { stateCode: 'not_found' }))
        .detail,
    ).toBe(AWS_SOURCE_STATE_CODE_TEXTS.not_found);
    expect(awsSourceHealthText(authorizedSourceFixture('waf', 'source_missing')).detail).toBe(
      AWS_SOURCE_STATE_CODE_TEXTS.not_found,
    );
    // O serviço desligado depois da autorização: religar e tentar de novo, ou retirar a autorização.
    expect(
      awsSourceHealthText(
        authorizedSourceFixture('inspector', 'source_missing', { stateCode: 'not_enabled' }),
      ).detail,
    ).toMatch(/foi desligado na conta depois da autorização.*Tentar de novo/);
    expect(
      awsSourceHealthText(
        authorizedSourceFixture('waf', 'source_missing', { stateCode: 'unsupported_destination' }),
      ).detail,
    ).toMatch(/Firehose.*Depois de corrigir na AWS, clique em Tentar de novo\.$/);
    // A autorização desligada na pilha, vista pelo coletor: o motivo da permissão.
    expect(
      awsSourceHealthText(
        authorizedSourceFixture('guardduty', 'permission_error', {
          stateCode: 'capability_off',
          permission: 'missing',
          permissionDetail: 'capability_off',
        }),
      ).detail,
    ).toBe('Falta permissão: a autorização deste tipo de fonte está desligada na pilha.');
    expect(
      awsSourceHealthText(
        authorizedSourceFixture('inspector', 'permission_error', {
          stateCode: 'inspector2:ListFindings',
          permission: 'missing',
          permissionDetail: 'inspector2:ListFindings',
        }),
      ).detail,
    ).toBe('Falta permissão: a AWS negou a ação inspector2:ListFindings.');
    expect(awsSourceHealthText(sourceFixture('config')).detail).toBe(
      AWS_SOURCE_STATE_CODE_TEXTS.not_collectable_yet,
    );
  });

  it('autorizações: o que cada uma permite e não permite, com a nota honesta dos buckets e como revogar', () => {
    expectTexts(AWS_READER_AUTHORIZATIONS, AWS_AUTHORIZATION_TEXTS);
    const logs = AWS_AUTHORIZATION_TEXTS['service-logs'].description;
    expect(logs).toMatch(/AWSLogs\/<conta>\//);
    expect(logs).toMatch(/nomes do primeiro nível dos buckets: só os nomes, nunca o conteúdo/);
    expect(AWS_AUTHORIZATION_TEXTS.findings.description).toMatch(/Não liga nenhum desses serviços/);
    expect(AWS_AUTHORIZATION_TEXTS['log-groups'].description).toMatch(/podem conter dados pessoais/);
    expect(AWS_AUTHORIZATION_FOOTNOTE).toMatch(/Nada é criado nem alterado na sua conta AWS/);
    expect(AWS_AUTHORIZATION_FOOTNOTE).toMatch(/desligue uma autorização .* ou apague a pilha/);
    expectTexts(AWS_READER_PREFILL_PROBLEMS, AWS_PREFILL_PROBLEM_TEXTS);
    expect(AWS_PREFILL_PROBLEM_TEXTS.service_account).toMatch(/Peça à Verax antes de criar a pilha/);
    expect(AWS_PREFILL_PROBLEM_TEXTS.egress_ips).toMatch(/Peça à Verax antes de criar a pilha/);
  });

  it('retrato da infraestrutura: todo campo do resumo tem rótulo', () => {
    expectTexts(Object.keys(awsInfrastructureSummarySchema.shape), AWS_INFRASTRUCTURE_LABELS);
  });

  it('recusas da API: todo código tem o texto dele, antes do genérico do status', () => {
    expectTexts(AWS_ONBOARDING_ERROR_CODES, AWS_ONBOARDING_ERROR_TEXTS);
    const refusal = (status: number, code?: string) => new ApiRequestError(status, 'mensagem da API', code);
    for (const code of AWS_ONBOARDING_ERROR_CODES) {
      expect(awsOnboardingErrorText(refusal(409, code)), code).toBe(AWS_ONBOARDING_ERROR_TEXTS[code]);
    }
    // O 429 da descoberta explica os 5 minutos, em vez de "muitas tentativas"; o da conferência de uma fonte, os 30 s.
    expect(awsOnboardingErrorText(refusal(429, 'DISCOVERY_RATE_LIMITED'))).toMatch(/a cada 5 minutos/);
    expect(awsOnboardingErrorText(refusal(429, 'SOURCE_RETRY_RATE_LIMITED'))).toMatch(/30 segundos depois/);
    expect(awsOnboardingErrorText(refusal(429))).toBe('Muitas tentativas. Aguarde alguns minutos.');
    expect(awsOnboardingErrorText(refusal(409, CONSOLE_MANAGED_CODE))).toMatch(/cadastrada pela Verax/);
    // Sem código conhecido, a mensagem de sempre; um nome de propriedade de objeto não vira código.
    expect(awsOnboardingErrorText(refusal(400, 'OUTRO'))).toBe('mensagem da API');
    expect(awsOnboardingErrorText(refusal(400, 'toString'))).toBe('mensagem da API');
    expect(awsOnboardingErrorText(new Error('rede'))).toMatch(/Não foi possível falar com o servidor/);
  });

  it('regiões do cadastro: todas válidas, sem repetir, com São Paulo como padrão', () => {
    const values = AWS_REGION_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    for (const option of AWS_REGION_OPTIONS) {
      expect(isAwsRegion(option.value), option.value).toBe(true);
      expect(option.label.startsWith(`${option.value} · `)).toBe(true);
    }
    expect(values[0]).toBe(AWS_DEFAULT_REGION);
    expect(AWS_DEFAULT_REGION).toBe('sa-east-1');
  });
});
