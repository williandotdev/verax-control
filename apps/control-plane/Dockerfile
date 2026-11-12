# Imagem do plano de controle do Verax Control (fase 3, CP-01). Contexto: a raiz do repositório; o .dockerignore
# só deixa entrar o necessário (nunca .env nem chaves). Molde de apps/api/Dockerfile.
#
# Uma só imagem para os serviços do Cloud Run: `cp-public`, `cp-worker` e `cp-admin` (o console do responsável, com
# login próprio) recebem a mesma imagem e a variável ROLE (public, worker ou admin) decide quais rotas existem. As telas
# do console (apps/console, React compilado pelo Vite) vão em /app/console e só o papel admin as serve; os dados só
# saem da API depois do login. Só dependências de produção, usuário sem privilégio, roda com sistema de arquivos só leitura e sem npm nem
# corepack, que não são usados em execução.
#
# A instalação respeita o pnpm-workspace.yaml: quarentena de 24 h, política de confiança e scripts de instalação
# bloqueados. Imagem base fixada por SHA-256 (a mesma da API).

ARG NODE_IMAGE=node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/console/package.json apps/console/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @verax/control-plane... --filter @verax/console...
COPY packages/shared packages/shared
COPY apps/control-plane apps/control-plane
COPY apps/console apps/console
COPY scripts/scan-bundle.mjs scripts/
# O contrato do canal da célula (CE-06) vem de `packages/shared`, compilado antes do plano de controle.
RUN pnpm --filter @verax/shared build && pnpm --filter @verax/control-plane build
# O console: checagem de tipos, build do Vite e a varredura de segredos do bundle (a mesma do painel).
RUN pnpm --filter @verax/console build
RUN pnpm --filter @verax/control-plane deploy --prod --legacy --ignore-scripts /out

FROM ${NODE_IMAGE} AS control-plane
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
# Arquivos do root: o usuário `node` não consegue alterá-los (e a raiz ainda é montada só leitura).
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/control-plane/dist ./dist
COPY --from=build /repo/apps/console/dist ./console
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/main.js"]
