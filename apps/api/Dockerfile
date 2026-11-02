# Imagem da API do Verax Control (T8.2). Contexto: a raiz do repositório; o .dockerignore só deixa entrar o necessário
# (nunca .env nem chaves).
#
# Alvos:
# - api (padrão): só dependências de produção, usuário sem privilégio, roda com sistema de arquivos só leitura;
# - migrate: a mesma imagem mais o schema e o Schema Engine já baixado, para a tarefa de migrations do deploy.
# As duas ficam sem npm e corepack, que não são usados em execução.
#
# A instalação respeita o pnpm-workspace.yaml: quarentena de 24 h, política de confiança e scripts de instalação
# bloqueados. Imagem base e bundle de CAs do RDS fixados por SHA-256.

ARG NODE_IMAGE=node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CHECKPOINT_DISABLE=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @verax/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @verax/shared build && pnpm --filter @verax/api build
RUN pnpm --filter @verax/api deploy --prod --legacy --ignore-scripts /out

FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
# CAs do RDS, para a conexão com o banco validar o certificado (sslmode=verify-full&sslrootcert=...).
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds/global-bundle.pem
# Arquivos do root: o usuário `node` não consegue alterá-los (e no ECS a raiz ainda é montada só leitura).
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
ENV NODE_ENV=production

FROM runtime AS migrate
COPY --from=build /repo/apps/api/prisma.config.ts ./
COPY --from=build /repo/apps/api/prisma ./prisma
# Baixa o Schema Engine no build (o CLI confere o checksum): a migration não depende da internet em produção.
RUN node_modules/.bin/prisma version > /dev/null
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

FROM runtime AS api
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/main.js"]
