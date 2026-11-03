import { describe, expect, it } from 'vitest';
import { BOM, toCsv } from './csv';

describe('CSV dos relatórios', () => {
  it('cabeçalho, aspas escapadas, vazio para nulo, CRLF e BOM do UTF-8', () => {
    const csv = toCsv(
      ['Nome', 'Achados'],
      [
        ['Usuário "admin"', 3],
        [null, 0],
      ],
    );
    expect(csv).toBe(`${BOM}"Nome","Achados"\r\n"Usuário ""admin""","3"\r\n,"0"\r\n`);
    expect(BOM).toBe(String.fromCharCode(0xfeff));
  });

  it.each(['=HYPERLINK("http://x")', '+1', '-2+3', '@SUM(A1)', '\tx'])(
    'texto que viraria fórmula na planilha ganha apóstrofo: %s',
    (value) => {
      expect(toCsv(['v'], [[value]])).toContain(`"'${value.replace(/"/g, '""')}"`);
    },
  );

  it('número negativo de verdade não é texto e fica como está', () => {
    expect(toCsv(['v'], [[-5]])).toContain('"-5"');
  });
});
