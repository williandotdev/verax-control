import type { CountryTraffic, OriginCounts, WorldTraffic } from '@/components/security/world-map-model';

/**
 * Dados fictícios do mapa de origens no catálogo, sempre os mesmos (gerador com semente fixa): um por estado que o mapa
 * precisa mostrar.
 */

const GENERATED_AT = '2026-11-24T17:30:00.000Z';

/** Os 250 códigos que a API pode mandar, em ordem de volume na demonstração (os primeiros são os maiores). */
export const DEMO_CODES: readonly string[] = [
  'BR US DE PT AR FR GB NL CN IN RU ES JP CA IT MX CL CO SG AU PL UA TR KR VN ID ZA SE IE CH BE UY PY PE HK RO CZ FI',
  'NO DK AT GR HU BG TH MY PH TW IL AE SA EG NG KE MA DZ TN GH AO MZ CV BO EC VE CR PA DO GT CU JM TT HN NI SV BZ HT',
  'NZ FJ PG NC PF RS HR SK SI LT LV EE IS LU MT CY MD BY GE AM AZ KZ UZ TM KG TJ MN PK BD LK NP BT MV MM KH LA BN TL',
  'IR IQ SY JO LB PS KW QA BH OM YE AF KP MO LY SD SS ET ER DJ SO UG RW BI TZ MW ZM ZW BW NA SZ LS MG MU SC KM CM GA',
  'CG CD CF TD NE ML BF CI SN GM GN GW SL LR TG BJ MR ST GQ XK AL BA ME MK AD MC SM VA LI FO GL GI IM JE GG AX SJ BM',
  'BS BB AG DM GD KN LC VC AI AW BL BQ CW GP KY MF MQ MS PM PR SX TC VG VI GF GY SR FK GS RE YT SH EH IO CC CX NF HM',
  'TF BV AQ UM AS CK FM GU KI MH MP NR NU PN PW SB TK TO TV VU WF WS',
].flatMap((line) => line.split(' '));

/** Gerador de números com semente (mulberry32): a mesma semente dá sempre a mesma sequência. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

const counts = (requests: number, blocked = 0, flagged = 0): OriginCounts => ({ requests, blocked, flagged });

interface Shape {
  seed: number;
  codes: readonly string[];
  /** O volume do maior país. */
  top: number;
  /** A chance de um país ter requisição suspeita e de estar ativo agora. */
  flaggedChance: number;
  recentChance: number;
}

function countriesOf({ seed, codes, top, flaggedChance, recentChance }: Shape): CountryTraffic[] {
  const random = seeded(seed);
  return codes.map((code, index) => {
    // Cauda longa: o segundo tem bem menos que o primeiro, e os últimos, um punhado.
    const requests = Math.max(1, Math.round((top / (index + 1) ** 1.6) * (0.7 + random() * 0.6)));
    const flagged = random() < flaggedChance ? Math.max(1, Math.round(requests * random() * 0.3)) : 0;
    // Os maiores estão sempre ativos; dos outros, uma parte.
    const recentRequests = index < 5 || random() < recentChance ? Math.max(1, Math.round(requests / 96)) : 0;
    return {
      code,
      ...counts(requests, Math.round(flagged * random()), flagged),
      recentRequests,
      recentFlagged: flagged > 0 && random() < 0.5 ? Math.min(recentRequests, Math.ceil(flagged / 96)) : 0,
    };
  });
}

const base = (countries: readonly CountryTraffic[]): WorldTraffic => ({
  generatedAt: GENERATED_AT,
  windowHours: 24,
  recentMinutes: 15,
  countries,
  unknown: counts(0),
  throughProxy: counts(0),
  internal: counts(0),
});

const COMMON: WorldTraffic = {
  ...base(
    countriesOf({
      seed: 11,
      codes: DEMO_CODES.slice(0, 48),
      top: 184_000,
      flaggedChance: 0.18,
      recentChance: 0.55,
    }),
  ),
  unknown: counts(1_204, 3, 18),
  throughProxy: counts(20_480, 12, 96),
  internal: counts(3_310),
};

/** Os estados do mapa, com o nome que aparece no seletor do catálogo. Sem tráfego (`null`), o mapa carregando. */
export const WORLD_MAP_DEMOS: readonly { key: string; label: string; traffic: WorldTraffic | null }[] = [
  { key: 'comum', label: 'Dia comum', traffic: COMMON },
  {
    key: 'ataque',
    label: 'Ataque de muitos países',
    traffic: {
      ...base(
        countriesOf({
          seed: 23,
          codes: DEMO_CODES.slice(0, 90),
          top: 96_000,
          flaggedChance: 0.7,
          recentChance: 0.8,
        }),
      ),
      unknown: counts(2_980, 610, 1_830),
    },
  },
  {
    key: 'todos',
    label: 'Os 250 países',
    traffic: {
      ...base(
        countriesOf({ seed: 37, codes: DEMO_CODES, top: 2_400_000, flaggedChance: 0.3, recentChance: 0.9 }),
      ),
      unknown: counts(8_112, 40, 350),
    },
  },
  {
    key: 'um',
    label: 'Um país só',
    traffic: base([{ code: 'BR', ...counts(312), recentRequests: 4, recentFlagged: 0 }]),
  },
  {
    key: 'cdn',
    label: 'Atrás de uma CDN',
    traffic: {
      ...base(
        countriesOf({ seed: 5, codes: ['BR', 'US', 'DE'], top: 840, flaggedChance: 0.5, recentChance: 1 }),
      ),
      throughProxy: counts(412_900, 2_010, 3_402),
      internal: counts(9_640),
    },
  },
  {
    key: 'sem-pais',
    label: 'Nenhum país identificado',
    traffic: { ...base([]), unknown: counts(57, 0, 2), internal: counts(1_940) },
  },
  { key: 'vazio', label: 'Sem requisições', traffic: base([]) },
  {
    key: 'enorme',
    label: 'Números enormes',
    traffic: {
      ...base(
        countriesOf({
          seed: 41,
          codes: DEMO_CODES.slice(0, 120),
          top: 98_765_432_109,
          flaggedChance: 0.25,
          recentChance: 0.7,
        }),
      ),
      throughProxy: counts(123_456_789_012, 9_876_543, 12_345_678),
    },
  },
  {
    key: 'parada',
    label: 'Sem logs novos',
    // Sem log há horas, ninguém tem requisição nos últimos minutos.
    traffic: {
      ...COMMON,
      countries: COMMON.countries.map((item) => ({ ...item, recentRequests: 0, recentFlagged: 0 })),
      state: 'stale',
      lastLogAt: '2026-11-24T13:05:00.000Z',
    },
  },
  { key: 'falhou', label: 'Atualização falhou', traffic: { ...COMMON, refreshFailed: true } },
  { key: 'carregando', label: 'Carregando', traffic: null },
];
