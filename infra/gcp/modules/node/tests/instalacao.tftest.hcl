# A instalação sem operador (`unattended_install`, PR-N7), como o envs/tenant a liga. Desligada (o padrão), a chave
# `startup-script` é o startup.sh.tftpl com o perfil trocado, byte a byte (este arquivo, `perfis`, `tenant` e
# `lean_verax`): o nó da Verax e a homologação não mudam. Ligada, o script de boot é o unattended.sh.tftpl, que leva o
# mesmo script de boot, o instalador, o verificador do manifesto e as chaves públicas de release do pacote do nó
# (infra/node), todos em base64, e nada mais nos metadados muda. O comportamento do script na VM é testado em
# infra/node/tests/boot-install-test.sh.
#
# Provider simulado: nada fala com a GCP, e nenhuma credencial é usada. O projeto, o cliente e os e-mails são fictícios.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      name      = "projects/projeto-exemplo-nos/serviceAccounts/vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"
      email     = "vx-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"
      unique_id = "123456789012345678901"
    }
  }

  mock_resource "google_compute_address" {
    defaults = {
      address = "203.0.113.20"
    }
  }
}

variables {
  project_id               = "projeto-exemplo-nos"
  region                   = "southamerica-east1"
  zone                     = "southamerica-east1-b"
  name_prefix              = "vx-demo-a"
  node_profile             = "standard"
  subnet_cidr              = "10.1.0.0/24"
  support_bootstrap_secret = true
  guest_attributes         = true
  install_config           = true
  install_metadata = {
    verax-plan                    = "profissional"
    verax-plan-max-cloud-accounts = ""
    verax-plan-max-users          = ""
    verax-plan-monthly-gib        = ""
    verax-plan-history-days       = ""
    verax-node-version            = "node-v1.2.3"
    verax-node-package-sha256     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    verax-images-repository       = "us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control"
    verax-web-origin              = "https://demo-a.control.example.com"
    verax-api-origin              = "https://api-demo-a.example.com"
    verax-mail-from               = "nao-responda@example.com"
    verax-tenant-name             = "Cliente Demo A"
    verax-admin-email             = "admin@cliente-demo-a.example.com"
    verax-support-email           = "suporte@example.com"
  }
}

# Sem a variável, o nó de cliente com tudo o mais ligado tem o script de boot de sempre.
run "desligada_por_padrao" {
  command = plan

  assert {
    condition     = google_compute_instance.node.metadata["startup-script"] == replace(file("startup.sh.tftpl"), "$${node_profile}", "standard")
    error_message = "Sem unattended_install, o script de boot não é mais o startup.sh.tftpl com o perfil trocado."
  }
}

# Ela depende do que os outros interruptores ligam: as chaves dos metadados, os atributos de convidado (verax/ready e
# verax/error) e os cofres das duas senhas temporárias (o modo cliente). Só no standard, e nunca com o script de boot
# do nó da Verax.
run "recusa_sem_a_configuracao_nos_metadados" {
  command = plan

  variables {
    unattended_install = true
    install_config     = false
    install_metadata   = {}
  }

  expect_failures = [var.unattended_install]
}

run "recusa_sem_os_atributos_de_convidado" {
  command = plan

  variables {
    unattended_install = true
    guest_attributes   = false
  }

  expect_failures = [var.unattended_install]
}

run "recusa_sem_o_cofre_da_conta_de_suporte" {
  command = plan

  variables {
    unattended_install       = true
    support_bootstrap_secret = false
  }

  expect_failures = [var.unattended_install]
}

run "recusa_no_lean" {
  command = plan

  variables {
    unattended_install = true
    node_profile       = "lean"
  }

  expect_failures = [var.unattended_install]
}

run "recusa_com_o_script_de_boot_antigo" {
  command = plan

  variables {
    unattended_install    = true
    legacy_startup_script = "#!/bin/bash\n"
  }

  expect_failures = [var.unattended_install]
}

# Por último: o `apply` simulado guarda o estado, e um `plan` seguinte noutro perfil tentaria destruir o IP do NAT.
run "ligada" {
  variables {
    unattended_install = true
  }

  # O modelo, com o perfil e sem nenhuma interpolação sobrando.
  assert {
    condition = (
      startswith(google_compute_instance.node.metadata["startup-script"], "#!/bin/bash\n# Script de boot do nó com a instalação sem operador") &&
      strcontains(google_compute_instance.node.metadata["startup-script"], "\nprofile='standard'\n") &&
      !strcontains(google_compute_instance.node.metadata["startup-script"], "$${") &&
      !strcontains(google_compute_instance.node.metadata["startup-script"], "%%{") &&
      endswith(google_compute_instance.node.metadata["startup-script"], "exec bash \"$boot/boot-install.sh\" --boot-dir \"$boot\" --profile \"$profile\"\n")
    )
    error_message = "O script de boot da instalação sem operador não é o unattended.sh.tftpl com o perfil standard."
  }

  # Cada peça entra inteira, num heredoc só dela: o script de boot de sempre, o instalador e o verificador do pacote do
  # nó, e cada chave pública de release com o nome do arquivo.
  assert {
    condition = (
      strcontains(google_compute_instance.node.metadata["startup-script"], "<<'VERAX_PREPARE'\n${base64encode(replace(file("startup.sh.tftpl"), "$${node_profile}", "standard"))}\nVERAX_PREPARE\n") &&
      strcontains(google_compute_instance.node.metadata["startup-script"], "<<'VERAX_INSTALLER'\n${base64encode(file("../../../node/bin/boot-install.sh"))}\nVERAX_INSTALLER\n") &&
      strcontains(google_compute_instance.node.metadata["startup-script"], "<<'VERAX_VERIFIER'\n${base64encode(file("../../../node/bin/verify-release.sh"))}\nVERAX_VERIFIER\n") &&
      strcontains(google_compute_instance.node.metadata["startup-script"], "<<'VERAX_RELEASE_KEYS'\n${join("\n", [for name in sort(fileset("../../../node/keys", "release-*.pem")) : "${name} ${base64encode(file("../../../node/keys/${name}"))}"])}\nVERAX_RELEASE_KEYS\n") &&
      strcontains(google_compute_instance.node.metadata["startup-script"], "\nrelease-node-manifest-v1.pem ")
    )
    error_message = "O script de boot não leva o script de boot do módulo, o instalador, o verificador e as chaves de release do pacote do nó."
  }

  # O valor de um metadado tem até 256 KB.
  assert {
    condition     = length(google_compute_instance.node.metadata["startup-script"]) < 200000
    error_message = "O script de boot da instalação sem operador passou de 200 mil caracteres (o teto da GCP é 256 KB por valor)."
  }

  # O resto dos metadados é o mesmo do nó de cliente: as chaves da instalação, os atributos de convidado e as chaves de
  # segurança, sem nada a mais.
  assert {
    condition = google_compute_instance.node.metadata == tomap(merge(output.install_metadata, {
      enable-oslogin         = "TRUE"
      block-project-ssh-keys = "TRUE"
      serial-port-enable     = "FALSE"
      startup-script         = google_compute_instance.node.metadata["startup-script"]
    })) && google_compute_instance.node.metadata_startup_script == null
    error_message = "A instalação sem operador mudou outros metadados da VM além do script de boot."
  }
}
