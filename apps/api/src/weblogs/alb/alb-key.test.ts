import { describe, expect, it } from 'vitest';
import { ACCOUNT, LB, objectKey, REGION, T0 } from '../../../test/support/alb-lines.js';
import { type AlbKeyExpectation, matchesExpectation, parseAlbKey } from './alb-key.js';

const EXPECT: AlbKeyExpectation = { prefix: '', accountId: ACCOUNT, region: REGION, loadBalancer: LB };
const KEY = objectKey(T0);

describe('chave de objeto do ALB', () => {
  it('lê a gramática da documentação', () => {
    expect(parseAlbKey(KEY)).toEqual({
      key: KEY,
      prefix: '',
      accountId: ACCOUNT,
      region: REGION,
      lbName: 'loja',
      lbId: '0123456789abcdef',
      loadBalancer: LB,
      endMs: T0,
      nodeIp: '10.0.1.5',
    });
  });

  it('a pasta é o dia da entrega: um arquivo de fevereiro numa pasta de maio serve', () => {
    const late = objectKey(T0).replace('/2026/11/24/', '/2027/05/02/');
    expect(parseAlbKey(late)?.endMs).toBe(T0);
  });

  it('com prefixo, que precisa ser o esperado', () => {
    const key = parseAlbKey(objectKey(T0, { prefix: 'logs/alb' }));
    expect(key?.prefix).toBe('logs/alb');
    if (key === null) throw new Error('chave recusada');
    expect(matchesExpectation(key, EXPECT)).toBe(false);
    expect(matchesExpectation(key, { ...EXPECT, prefix: 'logs/alb' })).toBe(true);
  });

  it.each([
    ['outra conta', objectKey(T0, { account: '222222222222' })],
    ['outra região', objectKey(T0, { region: 'us-east-1' })],
    ['outro balanceador', objectKey(T0, { lb: 'app/outra/fedcba9876543210' })],
    ['nome com o mesmo começo', objectKey(T0, { lb: 'app/loja2/0123456789abcdef' })],
  ])('planta de %s não é a fonte', (_, planted) => {
    const key = parseAlbKey(planted);
    if (key === null) throw new Error('a chave é válida, só não é desta fonte');
    expect(matchesExpectation(key, EXPECT)).toBe(false);
  });

  it.each([
    ['vazia', ''],
    ['o teste de permissão da AWS', `AWSLogs/${ACCOUNT}/ELBAccessLogTestFile`],
    ['conta do caminho diferente da do nome', KEY.replace(`AWSLogs/${ACCOUNT}`, 'AWSLogs/222222222222')],
    ['log de conexão', KEY.replace('_app.loja', '_conn_log.app.loja')],
    ['log de conexão com outro começo', KEY.replace(`/${ACCOUNT}_elastic`, `/conn_log.${ACCOUNT}_elastic`)],
    ['NLB', KEY.replace('_app.', '_net.')],
    ['sem gzip', KEY.replace('.log.gz', '.log')],
    ['pasta a mais', KEY.replace('/24/', '/24/../24/')],
    ['ponto-ponto no prefixo com espaço', `a b/${KEY}`],
    ['aspa no prefixo', `a"b/${KEY}`],
    ['dia inexistente no nome', KEY.replace('20261124T1200Z', '20260231T1200Z')],
    ['hora inexistente', KEY.replace('T1200Z', 'T2560Z')],
    ['mês inexistente na pasta', KEY.replace('/2026/11/24/', '/2026/13/24/')],
    ['id do balanceador curto', KEY.replace('0123456789abcdef', '0123456789abcde')],
    ['IP do nó inválido', KEY.replace('10.0.1.5', '10.0.1.500')],
    ['aleatório com símbolo', KEY.replace('abc123', 'abc-123')],
    ['campo a mais', KEY.replace('abc123', 'abc123_x')],
    ['longa demais', `${'p'.repeat(500)}/${KEY}`],
    ['duas raízes', `AWSLogs/${KEY}`],
  ])('recusa: %s', (_, key) => {
    const parsed = parseAlbKey(key);
    expect(parsed === null || !matchesExpectation(parsed, EXPECT)).toBe(true);
  });

  it('recusa na gramática o que não é log de acesso de ALB', () => {
    for (const key of [
      KEY.replace('_app.loja', '_conn_log.app.loja'),
      KEY.replace('_app.', '_net.'),
      KEY.replace('20261124T1200Z', '20260231T1200Z'),
      `${'p'.repeat(500)}/${KEY}`,
    ]) {
      expect(parseAlbKey(key)).toBeNull();
    }
  });
});
