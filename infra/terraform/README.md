# Terraform do Verax Control

Infraestrutura da conta AWS da Verax. Tudo aqui é escrito e validado no CI (`.github/workflows/iac.yml`), mas
**nada é aplicado automaticamente**: não existe `plan` nem `apply` no CI até o deploy ser ligado
(`vars.AWS_DEPLOY_ENABLED`, épico E8). Nenhum recurso é criado pelo console.

## Estrutura

| Pasta                     | O que é                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap/`              | Bucket do state remoto e a chave KMS que o cifra. Roda uma vez por conta.                                                           |
| `modules/private-bucket/` | Todo bucket S3 da conta: sem acesso público, dono único, SSE-KMS, versionamento, só TLS ≥ 1.2, ciclo de vida.                       |
| `modules/kms/`            | Chaves do ambiente: `data` (buckets, discos, segredos) e `logs` (CloudWatch Logs). Rotação automática.                              |
| `modules/network/`        | VPC em 2 zonas, subnets públicas e privadas, NAT, flow logs cifrados, SG padrão sem regras, endpoints privados.                     |
| `modules/wazuh/`          | EC2 do Wazuh (só produção): subnet privada, acesso só por SSM, discos cifrados, senhas no Secrets Manager, bundle de `infra/wazuh`. |
| `modules/prowler/`        | Prowler agendado (só produção): ECR, tarefa Fargate, EventBridge Scheduler, bucket de resultados.                                   |
| `modules/database/`       | RDS PostgreSQL 18 privado, cifrado, TLS obrigatório, backups; senha mestra gerenciada pelo RDS.                                     |
| `modules/frontend/`       | Painel: bucket privado servido pelo CloudFront (OAC), cabeçalhos de segurança, certificado e WAF em us-east-1.                      |
| `modules/api/`            | API: ECR, ALB só HTTPS com WAF, ECS Fargate, tarefas de bootstrap e migrations, segredos por write-only, SES.                       |
| `envs/staging/`           | Staging pequeno: 1 NAT, sem Wazuh e só com dados fictícios. Dado real de cliente nunca chega aqui.                                  |
| `envs/production/`        | Produção: 1 NAT por zona e, a partir da T4.2, o Wazuh.                                                                              |

## Regras

- **Segredo nunca passa pelo state.** Senhas são geradas com recursos `ephemeral` e gravadas no Secrets Manager
  por argumentos _write-only_ (`secret_string_wo`). O RDS usa `manage_master_user_password`. Não existe
  `*.tfvars` com segredo; o `.gitignore` bloqueia `*.tfvars` e `backend.hcl`.
- **Nenhum ID de conta real no repositório.** Conta, bucket e chave do state ficam no `backend.hcl` local.
- **Versões fixas.** O provider AWS é travado com versão exata e o `.terraform.lock.hcl` de cada raiz guarda os
  hashes para Linux, Windows e macOS. O CI roda `init -lockfile=readonly`: provider diferente do travado falha.
  O Dependabot propõe as atualizações toda semana, com 7 dias de quarentena.
- **Exceção de política tem motivo no código.** Toda regra do checkov ignorada vem com
  `#checkov:skip=ID:motivo` no próprio recurso.
- **Tags padrão** (`Project`, `Environment`, `ManagedBy`) em todos os recursos, pelo `default_tags` do provider.

## Validar localmente

Ferramentas: Terraform 1.17, TFLint 0.65 e Docker (para o checkov). Nenhum comando abaixo precisa de credencial
da AWS.

```sh
terraform fmt -check -recursive infra/terraform
for root in bootstrap envs/staging envs/production; do
  terraform -chdir="infra/terraform/$root" init -backend=false -lockfile=readonly
  terraform -chdir="infra/terraform/$root" validate
done
(cd infra/terraform && tflint --init && tflint --recursive)
docker run --rm -v "$PWD:/src" -w /src \
  bridgecrew/checkov:3.4.0@sha256:ece5efac4443084ca273072909985dce988a81e8cc94faa305aeda0df27c68f9 \
  --directory infra --framework terraform --skip-download --compact --quiet
```

Ao trocar a versão do provider, regenere os hashes das quatro plataformas em cada raiz:

```sh
terraform providers lock -platform=linux_amd64 -platform=windows_amd64 \
  -platform=darwin_arm64 -platform=darwin_amd64
```

## Primeira configuração da conta (feita por quem administra a conta Verax)

Pré-requisito: acesso administrativo à conta Verax por SSO, com MFA. Nunca use chave de acesso do root.

1. **Bootstrap (uma vez):**

   ```sh
   cd infra/terraform/bootstrap
   terraform init
   terraform apply -var state_bucket_name=verax-control-tfstate-<sufixo-aleatorio>
   ```

   Anote as saídas `state_bucket` e `state_kms_key_arn`.

2. **Levar o state do próprio bootstrap para o bucket.** Crie `bootstrap/backend.tf` com:

   ```hcl
   terraform {
     backend "s3" {
       key          = "verax-control/bootstrap/terraform.tfstate"
       use_lockfile = true
       encrypt      = true
     }
   }
   ```

   Rode `terraform init -migrate-state -backend-config=../envs/staging/backend.hcl` (depois do passo 3), confira
   que o state está no bucket, apague o `terraform.tfstate` local e faça commit do `backend.tf`.

3. **Backend dos ambientes:** em `envs/staging` e `envs/production`, copie `backend.hcl.example` para
   `backend.hcl` e preencha bucket, região e ARN da chave com as saídas do passo 1.

4. **Domínios (pendência 4):** em cada ambiente, crie um `terraform.tfvars` local (fora do git) com:

   ```hcl
   panel_domain = "painel.exemplo.com.br"
   api_domain   = "api.painel.exemplo.com.br"
   dns_zone_id  = "Z0123456789ABCDEFGHIJ" # zona pública no Route53; omita se o DNS estiver em outro provedor
   ```

   Com a zona no Route53, o Terraform valida os certificados e cria os registros. Com o DNS em outro provedor:
   1. `terraform apply -target=module.frontend.aws_acm_certificate.panel` cria só o certificado;
   2. `terraform output panel_certificate_validation_records` mostra os CNAMEs de validação: crie-os no DNS;
   3. `terraform apply` completo, que espera a validação;
   4. aponte o domínio do painel (CNAME) para `terraform output panel_distribution_domain`.

5. **Ambientes:**

   ```sh
   cd infra/terraform/envs/staging
   terraform init -backend-config=backend.hcl
   terraform plan
   ```

   Revise o plano antes de qualquer `apply`. A partir do E8, staging e produção são aplicados pelo
   `deploy.yml`, com OIDC e aprovação manual para produção.

## Ligar o deploy (T8.5)

O pipeline (`.github/workflows/deploy.yml`) publica versões da aplicação; ele não muda infraestrutura. Cada ambiente
tem um papel de deploy assumido por OIDC, só pelo environment do GitHub de mesmo nome.

1. **Bootstrap** com o provedor OIDC do GitHub (`terraform apply` em `bootstrap/`, uma vez por conta).
2. **Ambiente** (`terraform apply` em `envs/staging` e depois em `envs/production`), ainda sem digests: cria
   repositórios, papéis, banco, ALB, CloudFront e a configuração lida pelo deploy.
3. **GitHub:** nos environments `staging` e `production` (este com aprovação obrigatória e só a partir da `main`),
   crie a variável `AWS_DEPLOY_ROLE_ARN` com a saída `deploy_role_arn` do ambiente. No repositório, crie a variável
   `AWS_DEPLOY_ENABLED=true`.
4. **Primeira publicação:** o deploy envia as imagens ao ECR e para, avisando que as tarefas ainda não existem. Aplique
   o Terraform do ambiente com os digests que ele mostrou
   (`-var api_image_digest=sha256:... -var migrate_image_digest=sha256:...`) e rode o deploy de novo.
5. **Daí em diante,** cada push na `main` repete CI, Segurança e IaC; constrói as imagens uma vez (Trivy e SBOM);
   publica no staging (bootstrap dos papéis de banco, migrations, serviço, painel, attestation de origem e ZAP) e,
   depois da aprovação, em produção.

Ao reaplicar o Terraform de um ambiente já publicado, use os digests da última versão para não voltar a uma imagem
antiga: `aws ssm get-parameter --name /verax-control/<nome>/release/images`. O serviço da API ignora a revisão em
uso (quem troca é o deploy); uma mudança de endurecimento nas tarefas entra na próxima versão publicada.
