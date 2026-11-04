// O template do papel de leitura sem chave (fase 2, PR-V3'), servido pelo próprio painel: é o arquivo do repositório,
// `infra/cloudformation/verax-control-reader.yaml`, importado como recurso. No build, o Vite o copia byte a byte para
// `assets/` com o hash do conteúdo no nome (cache imutável no Firebase Hosting); no servidor de desenvolvimento, serve o
// próprio arquivo. Não há cópia no código do painel nem nada preenchido: o cliente baixa exatamente o template revisado
// no commit do painel, da mesma origem, e o e2e confere byte a byte.
import templateUrl from '../../../../../infra/cloudformation/verax-control-reader.yaml?url';

export const AWS_READER_TEMPLATE_URL: string = templateUrl;
