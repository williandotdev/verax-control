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

   Com a zona no Route53, o Terraform valida os certificados e cria os registros. Com o DNS em outro provedor
   (é o caso da Verax: Cloudflare), siga a seção "DNS no Cloudflare" abaixo. Os valores da Verax estão em
   `terraform.tfvars.example` de cada ambiente.

5. **Ambientes:**

   ```sh
   cd infra/terraform/envs/staging
   terraform init -backend-config=backend.hcl
   terraform plan
   ```

   Revise o plano antes de qualquer `apply`. A partir do E8, staging e produção são aplicados pelo
   `deploy.yml`, com OIDC e aprovação manual para produção.

## DNS no Cloudflare

O DNS de `veraxsistemas.com.br` fica no Cloudflare. Painel e API rodam na AWS (CloudFront e ALB, com certificados do
ACM); o Cloudflare só aponta os nomes.

| Ambiente | Painel                                 | API                                        | Remetente dos e-mails                               |
| -------- | -------------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| Produção | `control.veraxsistemas.com.br`         | `api.control.veraxsistemas.com.br`         | `nao-responda@control.veraxsistemas.com.br`         |
| Staging  | `staging.control.veraxsistemas.com.br` | `api.staging.control.veraxsistemas.com.br` | `nao-responda@staging.control.veraxsistemas.com.br` |

**Todo registro abaixo fica com proxy desligado ("DNS only", nuvem cinza).** Com o proxy do Cloudflare na frente:

- a API veria o IP do Cloudflare em vez do IP do usuário, e o limite de tentativas de login e a auditoria
  passariam a misturar todo mundo;
- o WAF da AWS deixaria de enxergar quem ataca;
- o painel teria dois CDNs, com cache e cabeçalhos de segurança em conflito.

TLS, WAF e cabeçalhos ficam na AWS.

Antes de começar: se a zona tiver algum registro CAA, acrescente `0 issue "amazon.com"` (sem nenhum CAA, nada a
fazer). No Cloudflare, o campo "Name" recebe o nome sem `.veraxsistemas.com.br` (ex.: `api.control`).

Em cada ambiente (`envs/staging`, depois `envs/production`), com `terraform.tfvars` copiado do exemplo:

1. **Certificados.** Crie só os dois certificados:

   ```sh
   terraform apply -target=module.frontend.aws_acm_certificate.panel -target=module.api.aws_acm_certificate.api
   terraform output panel_certificate_validation_records
   terraform output api_certificate_validation_records
   ```

   No Cloudflare, crie um **CNAME** para cada registro de validação (nome `_xxxx.control` → valor
   `_yyyy.acm-validations.aws`). Eles ficam permanentes: o ACM os usa para renovar os certificados sozinho.

2. **Ambiente completo.** `terraform apply` (espera a validação dos certificados, alguns minutos depois do DNS).

3. **Nomes do painel e da API.** No Cloudflare:
   - **CNAME** `control` (staging: `staging.control`) → valor de `terraform output panel_distribution_domain`
     (`dxxxx.cloudfront.net`);
   - **CNAME** `api.control` (staging: `api.staging.control`) → valor de `terraform output api_alb_dns_name`
     (`...sa-east-1.elb.amazonaws.com`).

4. **E-mail (SES).**
   - **DKIM:** `terraform output ses_dkim_records` lista três registros. Para cada um, crie um **CNAME**
     (`<token>._domainkey.control` → `<token>.dkim.amazonses.com`).
   - **DMARC:** um **TXT** em `_dmarc.control` com `v=DMARC1; p=quarantine; adkim=s`. O SES assina com o
     domínio do remetente (DKIM alinhado), então a política pode ser estrita desde o início.
   - **Saída do sandbox:** no console do SES (`sa-east-1`), peça acesso de produção. Enquanto a conta estiver no
     sandbox, o SES só entrega para endereços verificados, e os convites não chegam aos clientes.

5. **Conferir.**

   ```sh
   curl -sI https://control.veraxsistemas.com.br/ | grep -i strict-transport-security
   curl -s https://api.control.veraxsistemas.com.br/health
   ```

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
