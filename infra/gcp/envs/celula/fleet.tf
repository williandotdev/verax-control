# A atualização da frota (docs/ARQUITETURA.md, "Atualização da frota"): a célula da Verax é a canária (onda 0). O
# cp-worker grava o pedido de versão nos metadados da VM da célula e acompanha o host pelos guest attributes, como faz
# com os nós dedicados no projeto dos nós (o `cpNodeUpdater` do envs/nodes-platform). Só com o canal ligado
# (`control_plane_project_id`), como o resto do que é do plano de controle aqui.
#
# O mínimo, e só nesta VM (a condição pelo nome, não pelo prefixo: neste projeto ficam também o nó lean da Verax e a
# chave de release, que o cp-worker não deve alcançar):
# - ler a VM (a impressão digital dos metadados), ler os atributos de convidado e gravar os metadados;
# - `iam.serviceAccountUser` na conta da VM da célula, que o Compute exige para gravar os metadados de uma VM com conta
#   de serviço. Não dá token da conta, e o cp-worker não cria recurso nenhum neste projeto.
# O risco aceito pela decisão de 16/11/2026 (o `setMetadata` alcança o `startup-script`) e as contenções estão no
# envs/nodes-platform (control_plane.tf). Aqui, o cp-worker não tem `start`/`stop` desta VM: um script de boot trocado
# só rodaria num reboot feito por outro.

resource "google_project_iam_custom_role" "cell_node_updater" {
  count = local.cell_channel ? 1 : 0

  project     = var.project_id
  role_id     = "cpCellNodeUpdater"
  title       = "Verax Control: pedido de versão da VM da célula"
  description = "Ler a VM e os atributos de convidado e gravar os metadados (o pedido de versão da frota) da VM da célula."
  permissions = [
    "compute.instances.get",
    "compute.instances.getGuestAttributes",
    "compute.instances.setMetadata",
  ]

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "worker_cell_node_updater" {
  count = local.cell_channel ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.cell_node_updater[0].id
  member  = local.cp_worker_member

  condition {
    title       = "Só a VM da célula"
    description = "O pedido de versão da frota, em nenhuma outra VM do projeto (o nó lean da Verax fica de fora)."
    expression  = "resource.type == \"compute.googleapis.com/Instance\" && resource.name.extract(\"/instances/{name}\") == \"${var.name_prefix}\""
  }
}

resource "google_service_account_iam_member" "worker_cell_sa_user" {
  count = local.cell_channel ? 1 : 0

  service_account_id = "projects/${var.project_id}/serviceAccounts/${module.node.service_account_email}"
  role               = "roles/iam.serviceAccountUser"
  member             = local.cp_worker_member
}
