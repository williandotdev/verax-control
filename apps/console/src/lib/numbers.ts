/**
 * Números do console em pt-BR: o que a tela mostra e o que o responsável digita. A API guarda dinheiro em centavos de
 * real e taxas entre 0 e 1; a tela mostra reais e percentuais. A leitura é por caractere (sem expressão regular sobre
 * o que foi digitado) e devolve `undefined` para campo vazio e `NaN` para texto que não é número: o campo vazio vai
 * à API como ausente (ela diz qual falta), e o inválido é avisado na hora, ao lado do campo.
 */

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const percent1 = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Centavos em reais: 249000 → "R$ 2.490,00". */
export function formatCents(cents: number): string {
  return brl.format(cents / 100);
}

/** "1.000". */
export function formatInteger(value: number): string {
  return integer.format(value);
}

/** Uma taxa entre 0 e 1 em percentual com uma casa: 0.5703 → "57,0%". */
export function formatRatio(ratio: number): string {
  return percent1.format(ratio);
}

/** Um número decimal como o responsável digitaria (vírgula, sem separador de milhar): 0.11 → "0,11". */
export function decimalText(value: number, maximumFractionDigits = 6): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits, useGrouping: false }).format(value);
}

/** Centavos no campo de reais: 249000 → "2.490,00". */
export function centsText(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    cents / 100,
  );
}

/** Taxa no campo de percentual: 0.0469 → "4,69". */
export function rateText(rate: number): string {
  return decimalText(Number((rate * 100).toFixed(6)), 4);
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function onlyDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (const char of text) if (!isDigit(char)) return false;
  return true;
}

/** Tira espaços (inclusive o não separável do `Intl`) e o prefixo de moeda. */
function clean(text: string): string {
  let value = text.split(' ').join('').split(' ').join('').trim();
  if (value.startsWith('R$')) value = value.slice(2);
  if (value.startsWith('US$')) value = value.slice(3);
  return value;
}

/** Inteiro: "1.000" ou "1000" → 1000. Vazio: `undefined`; outra coisa: `NaN`. */
export function parseInteger(text: string): number | undefined {
  const value = clean(text).split('.').join('');
  if (value === '') return undefined;
  return onlyDigits(value) ? Number(value) : Number.NaN;
}

/**
 * Decimal pequeno (dólares, horas, câmbio): aceita vírgula ou ponto como separador decimal, um só, sem milhar.
 * "0,11" e "0.11" → 0.11; "1,5" → 1.5.
 */
export function parseDecimal(text: string): number | undefined {
  const value = clean(text).split(',').join('.');
  if (value === '') return undefined;
  const parts = value.split('.');
  if (parts.length > 2) return Number.NaN;
  const [whole = '', fraction = ''] = parts;
  // "1," é alguém no meio da digitação: vale 1 até vir a casa decimal.
  if (!onlyDigits(whole) || (fraction !== '' && !onlyDigits(fraction))) return Number.NaN;
  return Number(value);
}

/** Grupos de milhar em pt-BR sem vírgula: "2.490" e "1.000.000" (o primeiro grupo sem zero à esquerda). */
function isThousandsGrouping(value: string): boolean {
  const groups = value.split('.');
  if (groups.length < 2) return false;
  const [first = ''] = groups;
  if (first.length < 1 || first.length > 3 || first.startsWith('0') || !onlyDigits(first)) return false;
  return groups.slice(1).every((group) => group.length === 3 && onlyDigits(group));
}

/**
 * Reais para centavos: "2.490,00", "2490", "2490,5" e "R$ 2.490" → 249000 (pt-BR: ponto de milhar e vírgula
 * decimal). Sem vírgula, o ponto só é milhar quando separa grupos de três ("2.490"); senão é decimal ("12.5").
 */
export function parseMoney(text: string): number | undefined {
  let value = clean(text);
  if (value === '') return undefined;
  if (value.includes(',')) value = value.split('.').join('').split(',').join('.');
  else if (isThousandsGrouping(value)) value = value.split('.').join('');
  const parts = value.split('.');
  if (parts.length > 2) return Number.NaN;
  const [whole = '', fraction = ''] = parts;
  if (!onlyDigits(whole) || (fraction !== '' && (!onlyDigits(fraction) || fraction.length > 2))) {
    return Number.NaN;
  }
  return Math.round(Number(value) * 100);
}

/** Percentual para taxa: "4,69" → 0.0469; "57" → 0.57. */
export function parsePercent(text: string): number | undefined {
  const value = parseDecimal(clean(text).split('%').join(''));
  if (value === undefined || Number.isNaN(value)) return value;
  return Number((value / 100).toFixed(8));
}
