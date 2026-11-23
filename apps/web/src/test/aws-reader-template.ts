import { AWS_READER_TEMPLATE_FILE } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import templateText from '../../../../infra/cloudformation/verax-control-reader.yaml?raw';

/**
 * O template do papel de leitura nos testes do painel. No navegador, o próprio painel serve o arquivo do repositório
 * (`features/admin/aws-reader-template.ts`); no jsdom não há servidor, então o teste responde o pedido com o mesmo
 * arquivo, lido do repositório como texto. Só para testes: nada daqui entra no build.
 */
export const READER_TEMPLATE_TEXT: string = templateText;

/**
 * A resposta do pedido do template (`fetch(AWS_READER_TEMPLATE_URL)`), para o `server.use` de cada teste. Pelo nome do
 * arquivo: o endereço do recurso no ambiente de teste é um caminho do disco.
 */
export function readerTemplateHandler(text: string = READER_TEMPLATE_TEXT) {
  return http.get(`*/${AWS_READER_TEMPLATE_FILE}`, () => HttpResponse.text(text));
}
