/**
 * Os códigos de país aceitos na tabela de endereços. O gerador (`scripts/update-ip-country.mjs`) roda este arquivo direto
 * no Node, que só remove os tipos: aqui não entra import de outro arquivo do projeto.
 */

/** ISO 3166-1 alpha-2: os 249 códigos oficiais, em ordem. */
export const ISO_3166_1_ALPHA_2: readonly string[] = [
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ',
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR',
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO',
  'JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR',
  'MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO',
  'RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV',
  'TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW',
].flatMap((line) => line.split(' '));

export interface SpecialCode {
  /** O código que vai para a tabela; null deixa o endereço sem país. */
  code: string | null;
  reason: string;
}

/**
 * Os códigos que aparecem na fonte e não são ISO 3166-1, com a decisão de cada um. Um código fora daqui e da ISO para o
 * gerador: a decisão é de quem revisa a atualização, e não do script.
 */
export const SPECIAL_CODES: Readonly<Record<string, SpecialCode>> = {
  XK: {
    code: 'XK',
    reason: 'Kosovo: código de uso livre na ISO, mas é o que todos usam; sem ele, o lugar sumiria do mapa.',
  },
  AC: {
    code: 'SH',
    reason: 'Ascensão: reservado na ISO; faz parte de SH (Santa Helena, Ascensão e Tristão da Cunha).',
  },
  TA: {
    code: 'SH',
    reason:
      'Tristão da Cunha: reservado na ISO; faz parte de SH (Santa Helena, Ascensão e Tristão da Cunha).',
  },
  AN: {
    code: null,
    reason: 'Antilhas Holandesas: retirado em 2010; hoje é BQ, CW ou SX, e a fonte não diz qual.',
  },
};

const ISO = new Set(ISO_3166_1_ALPHA_2);

/** O código que vale para um código da fonte: ele mesmo, o da tabela, null (sem país) ou undefined (desconhecido). */
export function resolveCountryCode(source: string): string | null | undefined {
  if (ISO.has(source)) return source;
  return Object.hasOwn(SPECIAL_CODES, source) ? SPECIAL_CODES[source]?.code : undefined;
}
