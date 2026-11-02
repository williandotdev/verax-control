# Terraform do Verax Control

Infraestrutura da conta AWS da Verax. Tudo aqui é escrito e validado no CI (`.github/workflows/iac.yml`), mas
**nada é aplicado automaticamente**: não existe `plan` nem `apply` no CI até o deploy ser ligado
(`vars.AWS_DEPLOY_ENABLED`, épico E8). Nenhum recurso é criado pelo console.

## Estrutura

| Pasta                     | O que é                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bootstrap/`              | Bucket do state remoto e a chave KMS que o cifra. Roda uma vez por conta.                                       |
| `modules/private-bucket/` | Todo bucket S3 da conta: sem acesso público, dono único, SSE-KMS, versionamento, só TLS ≥ 1.2, ciclo de vida.   |
| `modules/kms/`            | Chaves do ambiente: `data` (buckets, discos, segredos) e `logs` (CloudWatch Logs). Rotação automática.          |
| `modules/network/`        | VPC em 2 zonas, subnets públicas e privadas, NAT, flow logs cifrados, SG padrão sem regras, endpoints privados. |
| `envs/staging/`           | Staging pequeno: 1 NAT, sem Wazuh e só com dados fictícios. Dado real de cliente nunca chega aqui.              |
| `envs/production/`        | Produção: 1 NAT por zona e, a partir da T4.2, o Wazuh.                                                          |

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

4. **Ambientes:**

   ```sh
   cd infra/terraform/envs/staging
   terraform init -backend-config=backend.hcl
   terraform plan
   ```

   Revise o plano antes de qualquer `apply`. A partir do E8, staging e produção são aplicados pelo
   `deploy.yml`, com OIDC e aprovação manual para produção.
