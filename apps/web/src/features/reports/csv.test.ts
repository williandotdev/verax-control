import { describe, expect, it } from 'vitest';
import { BOM, toCsv } from './csv';

describe('CSV dos relatórios', () => {
  it('cabeçalho, ponto e vírgula, aspas escapadas, vazio para nulo, CRLF e BOM do UTF-8', () => {
    const csv = toCsv(
      ['Nome', 'Achados'],
      [
        ['Usuário "admin"; root', 3],
        [null, 0],
      ],
    );
    expect(csv).toBe(`${BOM}"Nome";"Achados"\r\n"Usuário ""admin""; root";"3"\r\n;"0"\r\n`);
    expect(BOM).toBe(String.fromCharCode(0xfeff));
  });

  it.each(['=HYPERLINK("http://x")', '+1', '-2+3', '@SUM(A1)', '\tx', '=1+1'])(
    'texto que viraria fórmula na planilha ganha apóstrofo: %s',
    (value) => {
      expect(toCsv(['v'], [[value]])).toContain(`"'${value.replace(/"/g, '""')}"`);
    },
  );

  it('número negativo de verdade não é texto e fica como está', () => {
    expect(toCsv(['v'], [[-5]])).toContain('"-5"');
  });

  it('identificador só de dígitos vai como texto, com o zero à esquerda (conta AWS)', () => {
    expect(toCsv(['Conta'], [['012345678901']])).toContain('"=""012345678901"""');
    // Qualquer outra coisa segue como texto comum: só dígitos entram na forma de fórmula.
    expect(toCsv(['v'], [['0123 =1+1']])).toContain('"0123 =1+1"');
    expect(toCsv(['v'], [['123"; =1']])).toContain('"123""; =1"');
  });
});
