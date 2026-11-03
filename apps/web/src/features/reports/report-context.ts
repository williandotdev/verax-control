import type { ReportPeriod } from '@verax/shared';
import { createContext } from 'react';

/**
 * O relatório que as tabelas mostram: o período dos números na tela e se eles já são os do período escolhido. Enquanto
 * o novo período carrega, a tela segue com os números anteriores e a exportação fica travada, para o CSV nunca sair
 * com o nome de um período e os números de outro.
 */
export const ReportContext = createContext<{ period: ReportPeriod; current: boolean }>({
  period: '30d',
  current: true,
});
