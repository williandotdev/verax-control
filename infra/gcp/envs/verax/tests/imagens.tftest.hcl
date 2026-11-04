# O registro das imagens do nó (images.tf) está no ar. Com tags imutáveis, o Artifact Registry não apaga nenhuma
# versão com tag ("If a repository has immutable tags enabled, tagged artifacts can't be deleted"), e o workflow
# `Imagens do nó` põe a tag do commit em toda imagem: a política DELETE não apagava nada, e o registro guardava todas
# as versões. Estes casos fixam a regra (uma política DELETE que alcança versões com tag nunca anda junto com
# `immutable_tags = true`), a retenção (a versão no ar, 3 versões de cada imagem, 30 dias) e os campos que recriariam o registro, que
# têm de ser os do registro no ar, para a mudança ser uma atualização no lugar. No provider google 8.9.0, nenhum campo
# de `docker_config` nem de `cleanup_policies` tem `ForceNew` (só `location`, `repository_id`, `format`, `mode`,
# `kms_key_name`, `remote_repository_config` e `project` têm), e mudar `docker_config` entra no `updateMask` como
# `dockerConfig`: o `plan` mostra `will be updated in-place`, nunca `must be replaced`.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. O simulado não aplica os padrões do provider
# (`mode`, `tag_state`) nem pede recriação; quem confere o `update in-place` de verdade é o `plan` contra o estado real
# (GUIA, passo 5).

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/projeto-exemplo/serviceAccounts/verax-node@projeto-exemplo.iam.gserviceaccount.com"
      email = "verax-node@projeto-exemplo.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_logging_project_sink" {
    defaults = {
      writer_identity = "serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id         = "projeto-exemplo"
  monitored_projects = ["projeto-exemplo", "projeto-exemplo-dois"]
  billing_account_id = "000000-000000-000000"
}

run "limpeza_alcanca_as_versoes_com_tag" {
  command = plan

  # A regra. `tag_state` sem valor é o padrão do provider, ANY: a política alcança versões com e sem tag.
  assert {
    condition = !(
      anytrue([for docker in google_artifact_registry_repository.node.docker_config : docker.immutable_tags == true]) &&
      anytrue([for policy in google_artifact_registry_repository.node.cleanup_policies :
        policy.action == "DELETE" && anytrue([for condition in policy.condition : condition.tag_state != "UNTAGGED"])
      ])
    )
    error_message = "Tags imutáveis junto com uma política DELETE que alcança versões com tag: toda imagem do nó tem a tag do commit, e a política não apagaria nada."
  }

  assert {
    condition     = length(google_artifact_registry_repository.node.docker_config) == 1 && google_artifact_registry_repository.node.docker_config[0].immutable_tags == false
    error_message = "As tags do registro do nó são mutáveis, de propósito: o nó instala pelo digest conferido (deploy.sh), nunca pela tag."
  }

  assert {
    condition = (
      !google_artifact_registry_repository.node.cleanup_policy_dry_run &&
      [for policy in google_artifact_registry_repository.node.cleanup_policies : policy.id if policy.action == "DELETE"] == ["apagar-antigas"] &&
      alltrue([for policy in google_artifact_registry_repository.node.cleanup_policies :
        length(policy.condition) == 1 && policy.condition[0].older_than == "2592000s" && policy.condition[0].tag_state != "UNTAGGED" && length(policy.most_recent_versions) == 0
        if policy.action == "DELETE"
      ])
    )
    error_message = "A política apagar-antigas apaga de verdade (sem dry run) o que tem mais de 30 dias, com ou sem tag."
  }

  # `cleanup_policies` é um conjunto no provider: a ordem dos blocos no arquivo não vale, só os ids.
  assert {
    condition     = toset([for policy in google_artifact_registry_repository.node.cleanup_policies : policy.id if policy.action == "KEEP"]) == toset(["manter-no-ar", "manter-recentes"])
    error_message = "As políticas KEEP são exatamente manter-no-ar (a versão que o nó roda) e manter-recentes (as 3 mais recentes)."
  }

  assert {
    condition = alltrue([for policy in google_artifact_registry_repository.node.cleanup_policies :
      length(policy.most_recent_versions) == 1 && policy.most_recent_versions[0].keep_count == 3 && try(length(policy.most_recent_versions[0].package_name_prefixes), 0) == 0 && length(policy.condition) == 0
      if policy.id == "manter-recentes"
    ])
    error_message = "A política manter-recentes guarda as 3 versões mais recentes de cada imagem (API e migrations), para voltar."
  }

  # A versão no ar: o deploy.sh grava a tag `no-<vm>` nas imagens instaladas. Sem esta política, um nó que fica mais
  # de 30 dias numa versão, com 3 publicações mais novas na `main`, perderia as próprias imagens, e o `compose pull`
  # da partida seguinte pararia o nó.
  assert {
    condition = alltrue([for policy in google_artifact_registry_repository.node.cleanup_policies :
      length(policy.condition) == 1 && length(policy.most_recent_versions) == 0 &&
      policy.condition[0].tag_state == "TAGGED" && tolist(policy.condition[0].tag_prefixes) == tolist(["no-"]) &&
      try(length(policy.condition[0].package_name_prefixes), 0) == 0 && try(length(policy.condition[0].version_name_prefixes), 0) == 0 &&
      policy.condition[0].older_than == null && policy.condition[0].newer_than == null
      if policy.id == "manter-no-ar"
    ])
    error_message = "A política manter-no-ar guarda toda versão com tag no- (a que o deploy.sh grava nas imagens instaladas), sem outro filtro."
  }
}

# O deploy.sh grava a tag que a política manter-no-ar procura: os dois lados do mesmo contrato.
run "deploy_marca_a_versao_no_ar" {
  command = plan

  assert {
    condition     = strcontains(file("${path.module}/../../../node/bin/deploy.sh"), "gcloud artifacts docker tags add \"$images/$image\" \"$images/$${image%@*}:no-$vm\"")
    error_message = "O deploy.sh não grava mais a tag no-<vm> nas imagens instaladas: a política manter-no-ar deixaria de proteger a versão no ar."
  }
}

# Os campos com `ForceNew` no provider, um a um, com os valores do registro no ar. Se um deles mudar, o `plan` recria
# o registro (e o nó perde as imagens publicadas); o que este PR muda fica fora desta lista. O `project` (também
# `ForceNew`) vem do bloco `provider`, é o `var.project_id` de sempre, e só se conhece no `apply`.
run "registro_no_ar_nao_e_recriado" {
  command = plan

  assert {
    condition = (
      google_artifact_registry_repository.node.location == "us-east1" &&
      google_artifact_registry_repository.node.repository_id == "verax-control" &&
      google_artifact_registry_repository.node.format == "DOCKER" &&
      (google_artifact_registry_repository.node.mode == null || google_artifact_registry_repository.node.mode == "STANDARD_REPOSITORY") &&
      google_artifact_registry_repository.node.kms_key_name == null &&
      length(google_artifact_registry_repository.node.remote_repository_config) == 0
    )
    error_message = "Um campo que recria o registro (lugar, nome, formato, modo, chave ou remoto) mudou: o plan mostraria must be replaced."
  }

  assert {
    condition     = output.images_repository == "us-east1-docker.pkg.dev/projeto-exemplo/verax-control"
    error_message = "O prefixo das imagens (IMAGES_REPOSITORY do node.conf e do environment imagens) mudou."
  }
}
