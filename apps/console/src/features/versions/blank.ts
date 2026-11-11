/**
 * Os esqueletos de um documento em branco (o primeiro modelo de custos ou a primeira tabela de preços): só a forma,
 * sem nenhum número. Os valores de verdade nunca moram no repositório, que é público: o responsável digita no
 * console (ou importa o arquivo dele, guardado fora do repositório), e a API diz o que falta.
 */
export function blankCostModel(): unknown {
  return {
    currency: 'brl',
    taxes: { rates: [] },
    fixedCosts: { items: [] },
    sources: [],
  };
}

export function blankPriceTable(): unknown {
  return {
    currency: 'brl',
    interval: 'month',
    taxMode: 'exclusive',
    sizing: { sizes: [] },
    plans: { plataforma: {}, dedicado: {}, vciso: {} },
  };
}
