import { describe, expect, it } from 'vitest';
import { albLine, LB, T0 } from '../../../test/support/alb-lines.js';
import { LineSplitter } from '../line-splitter.js';
import { MAX_LINE_CHARS, parseAlbLine, parseTime } from './alb-line.js';

const parsed = (line: string) => {
  const result = parseAlbLine(line);
  if (result === null) throw new Error('malformed');
  return result;
};

describe('linha do log de acesso do ALB', () => {
  it.each([29, 30, 36] as const)('lê a linha de %i campos e ignora a cauda que não usa', (fields) => {
    const line = parsed(
      albLine({
        fields,
        time: T0 - 1234,
        client: '192.0.2.44',
        status: 403,
        target: '-',
        sent: 777,
        method: 'POST',
        path: '/api/login?senha=x',
        domain: 'Loja.Exemplo.com.BR',
        actions: 'waf',
      }),
    );
    expect(line).toMatchObject({
      type: 'h2',
      timeMs: T0 - 1234,
      loadBalancer: LB,
      clientIp: '192.0.2.44',
      elbStatus: 403,
      targetStatus: 0,
      sentBytes: 777,
      method: 'POST',
      path: '/api/login',
      hasQuery: true,
      domainName: 'loja.exemplo.com.br',
      blocked: true,
      ambiguous: false,
    });
  });

  it('tolera campos novos no fim, de qualquer forma', () => {
    const line = parsed(`${albLine({ fields: 36, actions: 'waf,forward' })} novo "outro campo" 12 "-"`);
    expect(line).toMatchObject({ ambiguous: false, blocked: false, domainName: 'loja.exemplo.com.br' });
  });

  it('só é bloqueada se o waf foi a última ação', () => {
    expect(parsed(albLine({ actions: 'waf' })).blocked).toBe(true);
    expect(parsed(albLine({ actions: 'authenticate,waf' })).blocked).toBe(true);
    expect(parsed(albLine({ actions: 'waf,forward' })).blocked).toBe(false);
    expect(parsed(albLine({ actions: 'waf-failed' })).blocked).toBe(false);
    expect(parsed(albLine({ actions: '-' })).blocked).toBe(false);
  });

  it('IPv6: a porta vem depois do último dois-pontos', () => {
    expect(parsed(albLine({ client: '2001:db8::1' })).clientIp).toBe('2001:db8::1');
    expect(parsed(albLine({ client: '[2001:db8::1]' })).clientIp).toBe('2001:db8::1');
  });

  it('a requisição malformada (`-`) tem status e cliente, sem método nem caminho', () => {
    const line = parsed(albLine({ request: '- http://loja.exemplo.com.br:80- -', status: 400, target: '-' }));
    expect(line).toMatchObject({ method: null, path: null, elbStatus: 400, ambiguous: false });
  });

  it('websocket, gRPC e status ausente', () => {
    expect(
      parsed(
        albLine({ type: 'wss', request: 'GET wss://loja.exemplo.com.br:443/chat?t=1 HTTP/1.1', status: 101 }),
      ),
    ).toMatchObject({ type: 'wss', path: '/chat', elbStatus: 101 });
    expect(parsed(albLine({ type: 'grpcs', path: '/pacote.Servico/Metodo' })).path).toBe(
      '/pacote.Servico/Metodo',
    );
    expect(parsed(albLine({ status: '-', target: '-' }))).toMatchObject({ elbStatus: 0, targetStatus: 0 });
  });

  it.each([
    ['GET https://h:443 HTTP/1.1', '/', false],
    ['GET https://h:443?x=1 HTTP/1.1', '/', true],
    ['GET /relativo?u=https://outro/x HTTP/1.1', '/relativo', true],
    ['GET https://h:443/a#b HTTP/1.1', '/a', false],
    ['OPTIONS * HTTP/1.1', null, false],
    ['CONNECT h:443 HTTP/1.1', null, false],
    ['FOO-BAR https://h:443/.env HTTP/1.1', '/.env', false],
    ['GET https://h:443/sem-versao', '/sem-versao', false],
  ])('a URL de %s', (request, path, hasQuery) => {
    expect(parsed(albLine({ request }))).toMatchObject({ path, hasQuery });
  });

  it('o método longo demais não faz perder o caminho', () => {
    expect(parsed(albLine({ request: `${'A'.repeat(40)} https://h:443/.env HTTP/1.1` }))).toMatchObject({
      method: 'OTHER',
      path: '/.env',
    });
  });

  it('User-Agent ausente ou enorme', () => {
    expect(parsed(albLine({ userAgent: '-' })).userAgent).toBe('');
    const long = parsed(albLine({ userAgent: 'a'.repeat(8000) }));
    expect(long.userAgent).toHaveLength(512);
    expect(long.ambiguous).toBe(false);
  });

  it('o caminho é lido até 2048 caracteres', () => {
    expect(parsed(albLine({ path: `/${'a'.repeat(9000)}` })).path).toHaveLength(2048);
  });

  describe('texto do atacante na cauda', () => {
    const tail =
      '"Root=1" "falso.exemplo.com.br" "arn" 0 2026-11-24T11:59:00.000000Z "waf" "-" "-" "-" "-" "-" "-"';

    it('aspa no User-Agent não descarta a linha: sai sem host e sem bloqueio', () => {
      const line = parsed(albLine({ userAgent: 'x"y', status: 404, path: '/.env', client: '192.0.2.9' }));
      expect(line).toMatchObject({
        ambiguous: true,
        blocked: false,
        domainName: null,
        path: '/.env',
        elbStatus: 404,
        clientIp: '192.0.2.9',
      });
    });

    it.each([
      ['cauda falsa completa no User-Agent', { userAgent: `x" - - - ${tail} TID_x "z` }],
      [
        'cauda falsa curta no User-Agent',
        { userAgent: `x" - - - "t" "d" "c" 0 2026-11-24T11:59:00.000000Z "waf` },
      ],
      [
        'cauda falsa no trace id',
        { trace: `t" "falso.exemplo.com.br" "c" 0 2026-11-24T11:59:00.000000Z "waf` },
      ],
      ['cauda falsa na URL de redirecionamento', { redirect: 'x" - 2026-11-24T11:59:00.000000Z "waf' }],
      ['aspa escapada', { userAgent: 'x\\" - - - "t' }],
      ['aspa na URL', { path: '/a"b' }],
      ['aspa solta no fim', { redirect: 'x"' }],
    ])('%s: nunca fabrica bloqueio nem host', (_, spec) => {
      for (const fields of [29, 36] as const) {
        const line = parsed(albLine({ ...spec, fields, actions: 'waf,forward' }));
        expect(line.blocked).toBe(false);
        expect([null, 'loja.exemplo.com.br']).toContain(line.domainName);
      }
    });

    it('barra invertida em qualquer lugar deixa a fronteira dos campos incerta', () => {
      expect(parsed(albLine({ userAgent: 'app C:\\dados' }))).toMatchObject({
        ambiguous: true,
        domainName: null,
      });
    });

    it('um campo com as aspas trocadas é ambíguo', () => {
      const bare = albLine({ actions: 'waf' }).replace('"loja.exemplo.com.br"', 'loja.exemplo.com.br');
      expect(parsed(bare)).toMatchObject({ ambiguous: true, blocked: false });
      const quotedCipher = albLine({ actions: 'waf' }).replace('TLSv1.3', '"TLSv1.3"');
      expect(parsed(quotedCipher)).toMatchObject({ ambiguous: true, blocked: false });
    });

    it('a cauda incompleta é ambígua, não malformada', () => {
      const cut = albLine().split(' ').slice(0, 16).join(' ');
      expect(parseAlbLine(cut)).toMatchObject({ ambiguous: true });
    });

    it('um SNI que não tem forma de host não vira host', () => {
      expect(parsed(albLine({ domain: 'a b' })).domainName).toBeNull();
      expect(parsed(albLine({ domain: '<script>' })).domainName).toBeNull();
      expect(parsed(albLine({ domain: '-' })).domainName).toBeNull();
    });
  });

  it.each([
    ['vazia', ''],
    ['lixo', 'qualquer coisa'],
    ['horário inválido', albLine({ time: '2026-13-40T99:00:00.000000Z' })],
    ['status inválido', albLine().replace(' 200 200 ', ' 2x0 200 ')],
    ['bytes inválidos', albLine({ sent: '-5' })],
    ['sem porta', albLine().replace('192.0.2.10:44321', '192.0.2.10')],
    ['sem aspa na requisição', albLine().replace('"GET', 'GET')],
    ['maior que 64 KB', `${albLine()} ${'a'.repeat(MAX_LINE_CHARS)}`],
  ])('malformada: %s', (_, line) => {
    expect(parseAlbLine(line)).toBeNull();
  });

  it('o horário, com e sem fração', () => {
    expect(parseTime('2026-11-24T10:00:00.123456Z')).toBe(Date.UTC(2026, 10, 24, 10, 0, 0, 123));
    expect(parseTime('2026-11-24T10:00:00Z')).toBe(Date.UTC(2026, 10, 24, 10, 0, 0));
    for (const bad of [
      '',
      '2026-11-24',
      '2026-11-24T10:00:00.xZ',
      '2026-11-24 10:00:00.1Z',
      '2026-11-24T10:00:00.1',
    ]) {
      expect(parseTime(bad)).toBe(-1);
    }
  });
});

describe('separação em linhas', () => {
  const collect = (chunks: readonly Uint8Array[]): { lines: string[]; oversize: number } => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    for (const chunk of chunks) splitter.push(chunk);
    splitter.end();
    return { lines, oversize: splitter.oversize };
  };

  it('o resultado não depende de onde os pedaços cortam', () => {
    const text = Buffer.from('uma\r\ndois\n\ntres');
    for (let cut = 0; cut <= text.length; cut += 1) {
      expect(collect([text.subarray(0, cut), text.subarray(cut)]).lines).toEqual(['uma', 'dois', 'tres']);
    }
  });

  it('a linha de 64 KB passa; a maior é pulada inteira, contada, e a seguinte é lida', () => {
    const exact = Buffer.alloc(MAX_LINE_CHARS, 97);
    expect(collect([exact, Buffer.from('\nfim\n')])).toMatchObject({ oversize: 0 });
    const big = Buffer.alloc(MAX_LINE_CHARS + 1, 97);
    expect(collect([big, Buffer.from('\nfim\n')])).toEqual({ lines: ['fim'], oversize: 1 });
    const pieces = Array.from({ length: 300 }, () => Buffer.alloc(1024, 97));
    expect(collect([...pieces, Buffer.from('\nfim')])).toEqual({ lines: ['fim'], oversize: 1 });
    expect(collect(pieces).oversize).toBe(1);
  });

  it('UTF-8 inválido não quebra: cada byte é um caractere, e a linha é analisada', () => {
    const bytes = Buffer.concat([
      Buffer.from(albLine({ path: '/AQUI' }).split('AQUI')[0] ?? ''),
      Buffer.from([0xc3, 0x28, 0xff, 0xfe, 0x80]),
      Buffer.from(albLine({ path: '/AQUI' }).split('AQUI')[1] ?? ''),
    ]);
    const { lines } = collect([bytes]);
    expect(lines).toHaveLength(1);
    expect(parseAlbLine(lines[0] ?? '')).toMatchObject({ ambiguous: false, elbStatus: 200 });
  });
});
