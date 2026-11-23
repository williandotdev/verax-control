// O template do papel de leitura sem chave (fase 2, PR-V3'), servido pelo próprio painel: é o arquivo do repositório,
// `infra/cloudformation/verax-control-reader.yaml`, importado como recurso. No build, o Vite o copia byte a byte para
// `assets/` com o hash do conteúdo no nome (cache imutável no Firebase Hosting); no servidor de desenvolvimento, serve o
// próprio arquivo. Não há cópia no código do painel: o link da alternativa manual baixa exatamente o template revisado
// no commit do painel, da mesma origem (o e2e confere byte a byte), e o "Conectar com AWS" lê este mesmo arquivo para
// montar, no navegador, o que sai com os valores do nó e as autorizações escolhidas (`aws-connect.ts`: só as linhas
// `Default:` mudam). Por isso uma mudança só no template publica a demonstração de novo (o filtro de caminhos do
// workflow `painel.yml`, conferido em `aws-reader-template.test.ts`).
import templateUrl from '../../../../../infra/cloudformation/verax-control-reader.yaml?url';

export const AWS_READER_TEMPLATE_URL: string = templateUrl;
