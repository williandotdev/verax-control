# Acessos de quem opera o nó quando a VM é recriada (a manutenção do swap no GUIA.md). A política de IAM de uma VM some
# com ela; os acessos têm de ser gravados de novo na VM nova, e só quando ela é recriada.
#
# Provider simulado: nada fala com a GCP. O `etag` de cada acesso vem do `override_resource` de cada etapa, e só um
# acesso criado (ou recriado) naquela etapa recebe o valor dela; um acesso que ficou como estava mantém o anterior.

mock_provider "google" {
  # O provider confere o formato destes valores no `apply`; o simulado inventaria textos soltos.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/projeto-exemplo-nos/serviceAccounts/verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
      email = "verax-teste@projeto-exemplo-nos.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id   = "projeto-exemplo-nos"
  region       = "us-east1"
  zone         = "us-east1-b"
  name_prefix  = "verax-teste"
  node_profile = "lean"
  subnet_cidr  = "10.80.0.0/24"
  operators    = ["user:operador@example.com"]
}

run "cria_o_no" {
  override_resource {
    target = google_compute_instance_iam_member.operators
    values = { etag = "vm-original" }
  }

  override_resource {
    target = google_iap_tunnel_instance_iam_member.operators
    values = { etag = "vm-original" }
  }

  assert {
    condition     = google_compute_instance_iam_member.operators["user:operador@example.com"].etag == "vm-original"
    error_message = "O acesso de administrador do operador não foi criado."
  }
}

run "recriar_a_vm_recria_os_acessos" {
  plan_options {
    replace = [google_compute_instance.node]
  }

  override_resource {
    target = google_compute_instance_iam_member.operators
    values = { etag = "vm-nova" }
  }

  override_resource {
    target = google_iap_tunnel_instance_iam_member.operators
    values = { etag = "vm-nova" }
  }

  assert {
    condition     = google_compute_instance_iam_member.operators["user:operador@example.com"].etag == "vm-nova"
    error_message = "A VM foi recriada e o login de administrador do operador não foi gravado de novo na VM nova."
  }

  assert {
    condition     = google_iap_tunnel_instance_iam_member.operators["user:operador@example.com"].etag == "vm-nova"
    error_message = "A VM foi recriada e o túnel do IAP do operador não foi gravado de novo na VM nova."
  }
}

run "mudanca_no_lugar_nao_mexe_nos_acessos" {
  variables {
    machine_type = "e2-small"
  }

  override_resource {
    target = google_compute_instance_iam_member.operators
    values = { etag = "nao-deveria-recriar" }
  }

  override_resource {
    target = google_iap_tunnel_instance_iam_member.operators
    values = { etag = "nao-deveria-recriar" }
  }

  assert {
    condition     = google_compute_instance.node.machine_type == "e2-small"
    error_message = "A VM não mudou de tamanho."
  }

  assert {
    condition = (
      google_compute_instance_iam_member.operators["user:operador@example.com"].etag == "vm-nova" &&
      google_iap_tunnel_instance_iam_member.operators["user:operador@example.com"].etag == "vm-nova"
    )
    error_message = "Uma mudança no lugar na VM recriou os acessos dos operadores."
  }
}
