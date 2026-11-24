import { describe, expect, it } from 'vitest';
import { sanitizeRawAlert } from '../../src/alerts/raw-alert.js';
import { REDACTED } from '../../src/alerts/raw-url-mask.js';
import { cloudTrailAlert, wafAlert } from './fixtures.js';

type Json = Record<string, unknown>;

/** O alerta do WAF da fixture com os campos dados em `httpRequest`. */
function wafWith(httpRequest: Json, extra: Json = {}): Json {
  const alert = wafAlert() as { data: { aws: Json & { httpRequest: Json } } };
  return {
    ...alert,
    data: {
      ...alert.data,
      aws: { ...alert.data.aws, ...extra, httpRequest: { ...alert.data.aws.httpRequest, ...httpRequest } },
    },
  };
}

const httpRequestOf = (clean: unknown) =>
  (clean as { data: { aws: { httpRequest: Json } } }).data.aws.httpRequest;

describe('URL e query do evento bruto (WAF): segredo e dado pessoal fora, o ataque legível', () => {
  it('uri e args: só os valores sensíveis mudam', () => {
    const request = httpRequestOf(
      sanitizeRawAlert(
        wafWith({
          uri: '/redefinir/ana@cliente.example',
          args: "busca=1' OR '1'='1&token=curto&cpf=123.456.789-09&senha=abc&pagina=2",
        }),
      ),
    );
    expect(request['uri']).toBe(`/redefinir/${REDACTED}`);
    expect(request['args']).toBe(
      `busca=1' OR '1'='1&token=${REDACTED}&cpf=${REDACTED}&senha=${REDACTED}&pagina=2`,
    );
  });

  it('o resto do evento do WAF não muda: quem bloqueou, a requisição, as impressões e o id', () => {
    const before = wafWith(
      { args: 'a=1', uri: '/login' },
      { ja3Fingerprint: 'd'.repeat(8) + '0a1b2c3d4e5f6a7b8c9d0e1f', labels: [{ name: 'awswaf:managed:x' }] },
    );
    const clean = sanitizeRawAlert(before) as { data: { aws: Json }; rule: unknown; location: unknown };
    const { httpRequest: _, ...rest } = (before as { data: { aws: Json } }).data.aws;
    const { httpRequest, ...cleanRest } = clean.data.aws;
    expect(cleanRest).toEqual(rest);
    expect(clean.rule).toEqual(before['rule']);
    expect(clean.location).toBe('Wazuh-AWS');
    expect(httpRequest).toMatchObject({ uri: '/login', args: 'a=1', httpMethod: 'POST', country: 'BR' });
  });

  it('cabeçalhos com URL (Referer, Location...) e cabeçalhos de credencial ou de dado pessoal', () => {
    const request = httpRequestOf(
      sanitizeRawAlert(
        wafWith({
          headers: {
            Host: 'app.exemplo',
            Referer: 'https://app.exemplo/cb?code=abc&x=<script>alert(1)</script>',
            Location: '/entrar?senha=abc',
            'X-Original-URL': '/a?email=ana@cliente.example',
            'X-Custom': 'https://app.exemplo/cb?token=abc',
            Authorization: 'Bearer abc',
            cookie: 'sessao=abc',
            'X-Auth-Token': 'abc',
            'X-Forwarded-Email': 'ana@cliente.example',
            'x-country-code': 'BR',
            'sec-ch-ua': '"Chromium";v="130"',
            'sec-ch-ua-mobile': '?1',
          },
        }),
      ),
    );
    expect(request['headers']).toEqual({
      Host: 'app.exemplo',
      Referer: `https://app.exemplo/cb?code=${REDACTED}&x=<script>alert(1)</script>`,
      Location: `/entrar?senha=${REDACTED}`,
      'X-Original-URL': `/a?email=${REDACTED}`,
      'X-Custom': `https://app.exemplo/cb?token=${REDACTED}`,
      Authorization: REDACTED,
      cookie: REDACTED,
      'X-Auth-Token': REDACTED,
      'X-Forwarded-Email': REDACTED,
      'x-country-code': 'BR',
      'sec-ch-ua': '"Chromium";v="130"',
      'sec-ch-ua-mobile': '?1',
    });
  });

  it('a lista de cabeçalhos do WAF lido do CloudWatch Logs segue as mesmas regras', () => {
    const request = httpRequestOf(
      sanitizeRawAlert(
        wafWith({
          headers: [
            { name: 'Host', value: 'app.exemplo' },
            { name: 'authorization', value: 'Bearer abc' },
            { name: 'Cookie', value: 'sessao=abc' },
            { name: 'referer', value: 'https://app.exemplo/cb?token=abc&a=1' },
            { name: 'user-agent', value: 'sqlmap/1.8' },
            { value: 'sem nome' },
            'texto solto',
          ],
        }),
      ),
    );
    expect(request['headers']).toEqual([
      { name: 'Host', value: 'app.exemplo' },
      { name: 'authorization', value: REDACTED },
      { name: 'Cookie', value: REDACTED },
      { name: 'referer', value: `https://app.exemplo/cb?token=${REDACTED}&a=1` },
      { name: 'user-agent', value: 'sqlmap/1.8' },
      { value: 'sem nome' },
      'texto solto',
    ]);
    const multi = sanitizeRawAlert({ multiValueHeaders: { Cookie: ['a=1'], Accept: ['*/*'] } });
    expect(multi).toEqual({ multiValueHeaders: { Cookie: REDACTED, Accept: ['*/*'] } });
  });

  it('qualquer outro campo que carrega a URL: log de acesso, query já separada, trechos casados e texto que cita', () => {
    const clean = sanitizeRawAlert({
      data: {
        url: '/entrar?senha=abc&x=1',
        protocol: 'GET',
        redirect_url: 'https://app.exemplo/fim?token=abc',
        'cs(Referer)': '/inicio?senha=abc',
        'cs(Cookie)': 'sessao=abc',
        authorization: 'Bearer abc',
        request_url: 'https://app.exemplo:443/cb?code=abc',
        'cs-uri-query': 'token=abc&x=1',
        mensagem: 'upstream "GET /cb?token=abc HTTP/1.1" falhou',
        queryStringParameters: { token: 'abc', cpf: 12345678909, busca: 'ana@cliente.example', pagina: '2' },
        ruleMatchDetails: [
          { conditionType: 'SQL_INJECTION', matchedData: ['ana@cliente.example', 'OR', '1'] },
        ],
      },
    });
    expect(clean).toEqual({
      data: {
        url: `/entrar?senha=${REDACTED}&x=1`,
        protocol: 'GET',
        redirect_url: `https://app.exemplo/fim?token=${REDACTED}`,
        'cs(Referer)': `/inicio?senha=${REDACTED}`,
        'cs(Cookie)': REDACTED,
        authorization: REDACTED,
        request_url: `https://app.exemplo:443/cb?code=${REDACTED}`,
        'cs-uri-query': `token=${REDACTED}&x=1`,
        mensagem: `upstream "GET /cb?token=${REDACTED} HTTP/1.1" falhou`,
        queryStringParameters: { token: REDACTED, cpf: REDACTED, busca: REDACTED, pagina: '2' },
        ruleMatchDetails: [{ conditionType: 'SQL_INJECTION', matchedData: [REDACTED, 'OR', '1'] }],
      },
    });
  });

  it('o que não carrega URL fica como está: a identidade, o recurso e os parâmetros do CloudTrail', () => {
    const alert = cloudTrailAlert() as { data: { aws: Json } };
    alert.data.aws['userIdentity'] = {
      arn: 'arn:aws:sts::111111111111:assumed-role/Admin/ana@empresa.example',
      userName: 'ana@empresa.example',
      accessKeyId: 'DEMOKEYID0000EXAMPLE',
    };
    alert.data.aws['requestParameters'] = { name: 'fila', key: 'valor', policy: '{"Action":"s3:*"}' };
    const { full_log: _, previous_output: __, ...expected } = alert as Json;
    expect(sanitizeRawAlert(alert)).toEqual(expected);
  });

  it('chave de protótipo numa lista de cabeçalhos ou na query não contamina nada', () => {
    const clean = sanitizeRawAlert(
      JSON.parse(
        '{"headers":[{"name":"x","value":"1","__proto__":{"poluido":true}}],"args":{"__proto__":{"poluido":true},"a":"1"}}',
      ),
    );
    expect(clean).toEqual({ headers: [{ name: 'x', value: '1' }], args: { a: '1' } });
    expect(({} as Json)['poluido']).toBeUndefined();
  });
});
