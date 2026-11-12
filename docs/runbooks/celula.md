# Célula compartilhada (Plataforma): infraestrutura, troca de modo e primeiro acesso dos clientes

A célula é um nó `standard` que atende vários clientes da Plataforma (docs/ARQUITETURA.md, "Célula compartilhada
(Plataforma)"). A primeira, `verax-celula`, é o `infra/gcp/envs/celula`, no projeto do nó da Verax, e hoje roda o SOC
da própria Verax como nó dedicado (`NODE_MODE` ausente, `PLAN=interno`). Este roteiro diz o que aplicar, em que ordem, e
como trocar o nó no ar para o modo célula sem perder o cliente da Verax. Nos comandos, `PROJETO_DO_NO` é o projeto da
célula, `PROJETO_CP` o do plano de controle e `URL_DO_CP_WORKER` o endereço do serviço cp-worker no Cloud Run. Os
valores reais ficam fora do repositório.

## O que a célula tem além de um nó

| Peça                                              | Onde                                              | Quem aplica                          |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| O nó (VM, rede, NAT, cofres, backups de 85 dias)  | `envs/celula` (módulo `node`)                     | O responsável                        |
| Canal: comandos `vxc-<célula>-commands`           | `envs/celula/cell.tf`                             | O responsável                        |
| Canal: relatórios `vxc-<célula>-reports` e o push | `envs/celula/cell.tf`                             | O responsável                        |
| Exportações dos clientes (31 dias)                | `envs/celula/cell.tf`                             | O responsável                        |
| O que é de cada cliente (conta de serviço, cofre) | `envs/cell-tenant` (CE-07), um estado por cliente | O plano de controle (`cp-terraform`) |

- **Comandos:** só o cp-worker publica, e só a VM da célula lê (com ordem por cliente).
- **Relatórios:** só a VM da célula publica; a assinatura push entrega em `URL_DO_CP_WORKER/internal/cells/<célula>/reports`,
  com o token OIDC da conta `vxc-<célula>-push`, que não tem papel nenhum. A rota, o `run.invoker` dessa conta no
  cp-worker e a conferência de que cada cliente citado é desta célula são do lado do plano de controle (CE-06).
- **Exportações:** a VM só cria objetos, e só em `<célula>/...`; o ciclo de vida apaga tudo com 31 dias.
- **Backups:** 85 dias (o `envs/celula` recusa mais), para o último backup com um cliente expurgado sair até cerca de
  D+95.

## 1. Aplicar o canal e as exportações (CE-03)

No `terraform.tfvars` do `envs/celula` (fora do repositório), acrescente os dois juntos:

```hcl
control_plane_project_id = "PROJETO_CP"
control_plane_worker_url = "URL_DO_CP_WORKER"
```

Depois, como sempre (`infra/gcp/GUIA.md`): `terraform plan` e, lendo o plano, `terraform apply`. O plano esperado só
cria (os tópicos, as assinaturas, a conta do push, o bucket das exportações e as permissões) e muda no lugar o ciclo de
vida do bucket de backups (de 90 para 85 dias). Nada na VM, no disco, na rede ou nos cofres muda; se o plano recriar a
VM, pare e confira. A saída `cell` traz o que o plano de controle registra da célula (o registro `cells/<id>`) e o que o
CE-06 configura do lado dele (a conta do push e o endereço).

## 2. Trocar o nó no ar para o modo célula (CE-04)

O nó continua com o mesmo banco: o cliente da Verax ganha o endereço da equipe (`TenantHost`) e o plano `interno`
gravado (`TenantPlan`), pelos escritores do sistema, e a API passa a amarrar cada requisição ao cliente do endereço.

1. **Instale a versão com a célula ainda como dedicado** (o `node.conf` de hoje): `infra/node/bin/deploy.sh COMMIT
node.conf` (docs/runbooks/no-verax.md, "Instalar ou atualizar").
2. **Adote o cliente da Verax**, ainda no dedicado, na VM:

   ```bash
   sudo /opt/verax/bin/start.sh cell-adopt verax
   ```

   Grava o endereço `verax` e, se faltar, o plano `interno` do único cliente do nó. Só roda com um cliente só e com
   `PLAN=interno`; repetir não muda nada ("já estava gravado"). Assim a célula já sobe com o endereço da equipe.

3. **Troque o `node.conf`:** tire `PLAN` (e qualquer `PLAN_*`) e o `NODE_SA_UNIQUE_ID`, e acrescente:

   ```
   NODE_MODE=cell
   CELL_DOMAIN=veraxsistemas.com.br
   CELL_STAFF_SLUG=verax
   ```

   `CUSTOMER_MODE` e `WAZUH_AGENTS` ficam `false`, e `NODE_PROFILE=standard`. Instale de novo com esse `node.conf`
   (`deploy.sh`): o `install.sh` confere a combinação, instala o `compose.cell.yaml` e liga o
   `verax-tenant-bootstrap.path` e o `.timer`.

4. **Confira:** `https://api-verax.veraxsistemas.com.br/health/ready` responde, o login da equipe funciona no painel
   `verax.control...`, e `sudo /opt/verax/bin/start.sh cell-adopt` (sem argumento, o `CELL_STAFF_SLUG`) diz que o
   endereço e o plano já estavam gravados.

**Voltar atrás:** o `node.conf` de antes (com `PLAN=interno`, sem `NODE_MODE`) e o `deploy.sh` de novo. O endereço e o
plano gravados ficam e não mudam nada no nó dedicado (o plano volta a vir do `node.conf`).

O que muda no nó na célula: a API recebe `NODE_MODE=cell`, `CELL_DOMAIN` e `CELL_STAFF_SLUG` no lugar do plano; o
worker recebe o modo e as pastas dos pedidos do primeiro acesso; ficam de fora o tópico do sink pelo nome do projeto (o
tópico é de cada conta, `vxc-<célula>-gcp-<UUID da conta>`) e o `NODE_SA_UNIQUE_ID` (a identidade da AWS passa a ser
de cada cliente, CE-11). Os agentes do Wazuh ficam desligados na célula (v1).

## 3. O primeiro administrador de cada cliente

O cliente nasce na célula pelo comando do plano de controle (CE-05), com o endereço e o plano. O primeiro
`admin_cliente` sai assim, sem a senha passar pelo worker:

1. o worker grava o pedido em `/run/verax/tenant-bootstrap/<id do cliente>` (duas linhas, `slug=<subdomínio>` e
   `email=<e-mail do administrador>`; nada de segredo);
2. o `verax-tenant-bootstrap.path` vê a pasta com pedido e roda `start.sh tenant-bootstrap-pending`. Para cada pedido, o
   host confere o formato (arquivo comum, até 512 bytes, subdomínio e e-mail válidos), roda o bootstrap no modo
   `cell-tenant` (o contêiner confere no banco que o cliente existe, está ativo, tem esse subdomínio e já tem plano) e
   grava a senha temporária no cofre do cliente, `vxt-<subdomínio>-admin-bootstrap` (criado pelo `envs/cell-tenant`, só
   com a gravação da VM). O plano de controle a revela uma vez, como no nó dedicado;
3. a resposta vai para `/run/verax/tenant-bootstrap-status/<id>`: `ok` (o pedido sai da pasta) ou `error` (o pedido
   fica, e o timer tenta de novo a cada 10 min).

Para ver ou repetir:

```bash
journalctl -u verax-tenant-bootstrap --since today
sudo /opt/verax/bin/start.sh tenant-bootstrap ID_DO_CLIENTE
# Senha nova a pedido (com um pedido na pasta):
sudo BOOTSTRAP_RENEW_ADMIN_PASSWORD=true /opt/verax/bin/start.sh tenant-bootstrap ID_DO_CLIENTE
```

Uma senha que não chegou ao cofre (o Secret Manager fora do ar, sem permissão) fica em
`/run/verax/tenant-bootstrap-payloads/<id>/` (tmpfs, só root) e vai antes de tudo na tentativa seguinte, para o cofre do
subdomínio que o host guardou. Nenhuma senha aparece na tela nem no journal.
