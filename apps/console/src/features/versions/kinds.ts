import type { VersionKind } from '@/lib/api';
import { blankCostModel, blankPriceTable } from './blank';

/** O que muda entre as duas telas de versões (modelos de custo e tabelas de preço); o ciclo de vida é o mesmo. */
export interface KindConfig {
  kind: VersionKind;
  /** "Modelos de custo". */
  title: string;
  /** "modelo de custos". */
  singular: string;
  /** Rota da lista. */
  basePath: string;
  description: string;
  /** O que a publicação faz, dito antes do botão. */
  publishNote: string;
  /** Pede a data de vigência ao publicar (só a tabela de preços; o modelo de custos vale na hora). */
  scheduledPublish: boolean;
  blank: () => unknown;
}

export const COST_MODELS: KindConfig = {
  kind: 'cost-models',
  title: 'Modelos de custo',
  singular: 'modelo de custos',
  basePath: '/modelos-de-custo',
  description:
    'Câmbio, a célula compartilhada da Plataforma, o nó por porte, a ingestão por GB/dia, tarifas, impostos, suporte por plano, custos fixos e as metas de margem. Confidencial: fica só no Firestore e neste console. Publicar muda as simulações e os alertas de margem, nunca o preço de ninguém.',
  publishNote:
    'O modelo publicado vale na hora para a checagem e o simulador. A tabela de preços vigente é conferida com ele e, se não passar, o alerta de margem vai ao log; a tabela não muda.',
  scheduledPublish: false,
  blank: blankCostModel,
};

export const PRICING_TABLES: KindConfig = {
  kind: 'pricing-tables',
  title: 'Tabelas de preço',
  singular: 'tabela de preços',
  basePath: '/tabelas-de-preco',
  description:
    'Os três planos por volume de logs em GB/dia (Plataforma, Dedicado e vCISO), a regra de porte e o lookup_key da Stripe de cada preço. A versão publicada é a que o site cota; uma versão nova nunca muda assinaturas existentes. Versões do modelo de preço anterior aparecem só na lista.',
  publishNote:
    'A publicação roda a checagem da grade inteira com o modelo de custos vigente e só passa se nenhuma configuração ficar abaixo da margem mínima. A versão anterior vira aposentada na vigência da nova.',
  scheduledPublish: true,
  blank: blankPriceTable,
};

/** Uma sugestão de versão nova: `AAAA-MM-vN`, o N seguinte entre as do mês. */
export function suggestVersion(existing: readonly string[], now: Date = new Date()): string {
  const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-v`;
  let next = 1;
  for (const version of existing) {
    if (!version.startsWith(prefix)) continue;
    const number = Number(version.slice(prefix.length));
    if (Number.isInteger(number) && number >= next) next = number + 1;
  }
  return `${prefix}${next}`;
}
