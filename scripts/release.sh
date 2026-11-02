#!/usr/bin/env bash
# Publica uma versão da API e do painel num ambiente (T8.5). Roda no deploy.yml, com o papel OIDC do ambiente, que
# não muda infraestrutura (isso é Terraform, aplicado por quem administra a conta).
#
# Uso: scripts/release.sh <staging|production>
# Pré-requisitos no runner: credenciais do papel de deploy; imagens locais verax-api:release e
# verax-api-migrate:release; build do painel em apps/web/dist, feito com o VITE_API_URL do ambiente.
#
# 1. envia as imagens ao ECR (tags imutáveis) e anota os digests;
# 2. registra revisões novas das tarefas, clonando a mais recente e trocando só a imagem: o endurecimento continua o
#    definido no Terraform;
# 3. bootstrap dos papéis de banco, migrations e bootstrap de novo; qualquer falha interrompe tudo e mostra o log;
# 4. atualiza o serviço da API e espera estabilizar (o ECS volta sozinho se a versão nova não ficar saudável);
# 5. registra as imagens publicadas; publica o painel (arquivos com hash em cache longo, index.html sem cache) e
#    invalida o CloudFront;
# 6. smoke test: /health da API e cabeçalhos de segurança do painel.
# Escreve em $GITHUB_OUTPUT os repositórios e digests publicados, para a attestation de origem.
set -euo pipefail
cd "$(dirname "$0")/.."

environment=${1:-}
if [[ ! $environment =~ ^(staging|production)$ ]]; then
  echo "Uso: scripts/release.sh <staging|production>" >&2
  exit 2
fi
name=verax-control-$environment
log() { printf '[release:%s] %s\n' "$environment" "$*"; }

config=$(aws ssm get-parameter --name "/verax-control/$name/release/config" --query Parameter.Value --output text)
cfg() { jq -er --arg key "$1" '.[$key]' <<<"$config"; }
region=$(cfg region)
export AWS_REGION=$region AWS_DEFAULT_REGION=$region
cluster=$(cfg cluster)
service=$(cfg service)
api_repository=$(cfg api_repository)
migrate_repository=$(cfg migrate_repository)
subnets=$(cfg subnets)
jobs_security_group=$(cfg jobs_security_group)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

log "1/6 Imagens para o ECR"
registry=${api_repository%%/*}
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
tag="git-${GITHUB_SHA:-local}-${GITHUB_RUN_ID:-0}.${GITHUB_RUN_ATTEMPT:-1}"
publish() { # <imagem local> <repositório>: imprime o digest publicado
  docker tag "$1" "$2:$tag"
  docker push --quiet "$2:$tag" >/dev/null
  docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$2:$tag" | grep -m1 "^$2@" | cut -d@ -f2
}
api_digest=$(publish verax-api:release "$api_repository")
migrate_digest=$(publish verax-api-migrate:release "$migrate_repository")
log "API $api_digest, migrations $migrate_digest"
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  {
    echo "api_repository=$api_repository"
    echo "api_digest=$api_digest"
    echo "migrate_repository=$migrate_repository"
    echo "migrate_digest=$migrate_digest"
  } >>"$GITHUB_OUTPUT"
fi

# Primeira publicação: as tarefas nascem no Terraform, que precisa dos digests das imagens já no ECR.
if ! aws ecs describe-task-definition --task-definition "$(cfg task_family_api)" >/dev/null 2>&1; then
  log "As tarefas ainda não existem (primeira publicação). As imagens já estão no ECR; aplique o Terraform do"
  log "ambiente com: -var api_image_digest=$api_digest -var migrate_image_digest=$migrate_digest"
  log "e rode o deploy de novo (README de infra/terraform, \"Ligar o deploy\")."
  exit 1
fi

log "2/6 Revisões das tarefas (só a imagem muda)"
register() { # <família> <imagem com digest>: imprime o ARN da revisão nova
  aws ecs describe-task-definition --task-definition "$1" --query taskDefinition --output json |
    jq --arg image "$2" '
      {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, volumes,
       requiresCompatibilities, cpu, memory, runtimePlatform}
      | with_entries(select(.value != null))
      | .containerDefinitions[0].image = $image' >"$work/$1.json"
  aws ecs register-task-definition --cli-input-json "file://$work/$1.json" \
    --query taskDefinition.taskDefinitionArn --output text
}
api_revision=$(register "$(cfg task_family_api)" "$api_repository@$api_digest")
bootstrap_revision=$(register "$(cfg task_family_db_bootstrap)" "$api_repository@$api_digest")
migrate_revision=$(register "$(cfg task_family_migrate)" "$migrate_repository@$migrate_digest")

log "3/6 Papéis de banco, migrations e papéis de novo"
run_job() { # <revisão> <nome do contêiner> <grupo de log>
  local task code
  task=$(aws ecs run-task --cluster "$cluster" --task-definition "$1" --launch-type FARGATE \
    --platform-version LATEST --started-by "deploy-$environment" \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$jobs_security_group],assignPublicIp=DISABLED}" \
    --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  if [[ $code != 0 ]]; then
    log "ERRO: $2 terminou com código $code. Últimas linhas do log:"
    aws logs get-log-events --log-group-name "$3" --log-stream-name "$2/$2/${task##*/}" --limit 50 \
      --query 'events[].message' --output text || true
    exit 1
  fi
  log "$2 ok"
}
run_job "$bootstrap_revision" db-bootstrap "$(cfg log_group_db_bootstrap)"
run_job "$migrate_revision" migrate "$(cfg log_group_migrate)"
run_job "$bootstrap_revision" db-bootstrap "$(cfg log_group_db_bootstrap)"

log "4/6 Serviço da API"
aws ecs update-service --cluster "$cluster" --service "$service" --task-definition "$api_revision" \
  --query service.serviceArn --output text >/dev/null
aws ecs wait services-stable --cluster "$cluster" --services "$service"
running=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
  --query 'services[0].taskDefinition' --output text)
if [[ $running != "$api_revision" ]]; then
  log "ERRO: o ECS voltou para a versão anterior (a nova não ficou saudável)."
  exit 1
fi

log "5/6 Painel"
aws ssm put-parameter --name "/verax-control/$name/release/images" --type String --overwrite \
  --value "$(jq -nc --arg api "$api_digest" --arg migrate "$migrate_digest" '{api: $api, migrate: $migrate}')" \
  >/dev/null
bucket=$(cfg panel_bucket)
# Arquivos com hash no nome (assets/) não mudam: cache longo. O resto, cache curto; o index.html, nenhum.
aws s3 sync apps/web/dist/assets/ "s3://$bucket/assets/" --only-show-errors \
  --cache-control "public, max-age=31536000, immutable"
aws s3 sync apps/web/dist/ "s3://$bucket/" --delete --only-show-errors --exclude "assets/*" --exclude index.html \
  --cache-control "public, max-age=300"
aws s3 cp apps/web/dist/index.html "s3://$bucket/index.html" --only-show-errors \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"
invalidation=$(aws cloudfront create-invalidation --distribution-id "$(cfg distribution_id)" --paths "/*" \
  --query Invalidation.Id --output text)
aws cloudfront wait invalidation-completed --distribution-id "$(cfg distribution_id)" --id "$invalidation"

log "6/6 Smoke test"
api_domain=$(cfg api_domain)
panel_domain=$(cfg panel_domain)
health=$(curl -s -o /dev/null -w '%{http_code}' --proto '=https' "https://$api_domain/health")
headers=$(curl -sI --proto '=https' "https://$panel_domain/")
failures=0
[[ $health == 200 ]] || { log "FALHA: /health da API respondeu $health"; failures=$((failures + 1)); }
for header in content-security-policy strict-transport-security x-frame-options referrer-policy; do
  grep -qi "^$header:" <<<"$headers" || { log "FALHA: painel sem $header"; failures=$((failures + 1)); }
done
if ((failures > 0)); then
  exit 1
fi
log "Versão publicada em $environment."
