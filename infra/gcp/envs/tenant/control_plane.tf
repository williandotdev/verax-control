# O que o cp-worker (`control_plane_sa`) pode nos cofres deste nó, e em nenhum outro: cada permissão vale só para um
# cofre (plano da fase 3, seção 2.2; docs/ARQUITETURA.md, "Identidades"). Nenhuma no projeto.
#
# - `admin-bootstrap`: ler a senha temporária do primeiro admin, uma vez, na revelação (`secretAccessor`), e destruir
#   a versão logo depois (`secretVersionManager`) (CP-05);
# - `cloudflare-tunnel-token`: gravar o token do túnel que ele mesmo criou no Cloudflare (`secretVersionAdder`; plano,
#   4c, passo 5). Não lê o token;
# - `smtp-password`, só com o e-mail do nó (`smtp_host`): gravar a senha da caixa de envio dos nós, que ele copia do
#   cofre `cp-nodes-smtp-password` do plano de controle (`secretVersionAdder`; o passo `secrets.smtp_password` e a
#   recópia na troca da senha). Não lê a senha de volta: quem lê é a VM, na partida;
# - `credentials-key`: destruir as versões na Exclusão 2 (D+97, cripto-destruição), com o `cpSecretVersionDestroyer` do
#   envs/nodes-platform (só listar e destruir). Nunca lê a chave: abrir o cofre de credenciais do cliente é o que o
#   plano de controle não pode fazer. O `secretVersionManager` predefinido que o plano citava também gravaria uma
#   versão nova da chave e reativaria uma desativada.
#
# Nada no `support-bootstrap` (a senha da conta de suporte da Verax): quem lê é só o responsável, com as permissões
# dele no projeto. Sem o e-mail do nó, nada no `smtp-password`.

locals {
  worker_member = "serviceAccount:${var.control_plane_sa}"
  secrets       = merge(module.node.secrets, module.node.node_written_secrets)
}

resource "google_secret_manager_secret_iam_member" "worker_admin_bootstrap" {
  for_each = toset(["roles/secretmanager.secretAccessor", "roles/secretmanager.secretVersionManager"])

  project   = var.project_id
  secret_id = local.secrets["admin-bootstrap"]
  role      = each.key
  member    = local.worker_member
}

resource "google_secret_manager_secret_iam_member" "worker_tunnel_token" {
  project   = var.project_id
  secret_id = local.secrets["cloudflare-tunnel-token"]
  role      = "roles/secretmanager.secretVersionAdder"
  member    = local.worker_member
}

resource "google_secret_manager_secret_iam_member" "worker_smtp_password" {
  count = var.smtp_host == "" ? 0 : 1

  project   = var.project_id
  secret_id = local.secrets["smtp-password"]
  role      = "roles/secretmanager.secretVersionAdder"
  member    = local.worker_member
}

# Na Exclusão 1 (D+30), este recurso e o cofre `credentials-key` saem do estado antes do `destroy` (`terraform state
# rm`), para o cofre e esta permissão ficarem até a Exclusão 2 (docs/ARQUITETURA.md, "Exclusão em dois tempos").
resource "google_secret_manager_secret_iam_member" "worker_credentials_key" {
  project   = var.project_id
  secret_id = local.secrets["credentials-key"]
  role      = "projects/${var.project_id}/roles/cpSecretVersionDestroyer"
  member    = local.worker_member
}
