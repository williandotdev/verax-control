# Instalação na VM própria do cliente (contrato direto)

Pelo site, o Verax Control roda sempre na infraestrutura da Verax. Num **contrato direto**, o responsável pode cadastrar
o cliente com o ambiente na **infraestrutura do próprio cliente** (console, Clientes → Novo cliente → "Infraestrutura do
cliente"). O cliente cria uma VM Linux, em qualquer nuvem ou no datacenter dele, e roda nela um comando. Este é o guia
que o cliente segue.

## Como fica

|                  | Na infraestrutura da Verax                     | Na VM do cliente (este guia)                                       |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| O que roda onde  | Tudo na Verax                                  | Na VM: API, worker, banco, Wazuh e o túnel. Na Verax: o painel     |
| Quem cria e paga | A Verax (provisionamento automático)           | A VM é do cliente, na conta dele                                   |
| Painel e API     | `<slug>.control.veraxsistemas.com.br`          | Os mesmos endereços: o painel na Verax, a API pelo túnel da Verax  |
| Primeiro acesso  | E-mail "ambiente pronto" com link de uso único | O mesmo e-mail, depois que a VM avisa que está pronta              |
| Portas abertas   | Nenhuma                                        | Nenhuma: a VM só faz conexões de saída                             |
| Acesso da Verax  | Ao ambiente                                    | Nenhum à VM: ela entrega o túnel e a senha do e-mail pelo registro |
| Atualização      | A Verax                                        | O cliente roda o instalador da versão nova com `--atualizar`       |
| Fim do contrato  | A Verax apaga tudo (D+30 e D+97)               | A Verax apaga o que é dela; o **cliente apaga a VM** (abaixo)      |

Na VM roda o mesmo pacote do nó da Verax, no modo `NODE_PLATFORM=vm`: os segredos ficam num cofre local
(`/etc/verax/vault`, só root), a chave do cofre de credenciais nasce na própria VM, os backups do banco ficam na VM
(`/var/lib/verax/backups`, 7 dias) e não há atualizador automático. Nenhum contêiner do nó alcança o servidor de
metadados da nuvem da VM (`169.254.169.254` e, na AWS, `fd00:ec2::254`): o serviço `verax-vm-metadata-guard`
bloqueia esse tráfego antes de o Docker subir, a cada boot (o próprio host continua com acesso). Nesta entrega, o nó coleta o Cloudflare (o token de
leitura colado no painel) e o que não depende de identidade de nuvem. **A coleta da AWS e do Google com chave de leitura
cadastrada no painel vem numa entrega seguinte.** Os agentes do Wazuh nas instâncias do cliente pedem portas de entrada
e não existem na VM própria.

## 1. A VM

O console (detalhe do cliente) mostra o porte do contrato. A VM precisa de, no mínimo:

| Porte | vCPU | Memória | Disco (onde fica `/var/lib`) |
| ----- | ---- | ------- | ---------------------------- |
| P     | 2    | 8 GB    | 60 GB                        |
| M     | 4    | 16 GB   | 120 GB                       |
| G     | 8    | 32 GB   | 240 GB                       |

O P é o nó de cliente da Verax (2 vCPU e 8 GB, com o Wazuh completo); o M e o G dobram o anterior. O instalador confere
com uma folga para o que o sistema reserva (7.500 MiB de memória visível e 55 GiB no sistema de arquivos, no P). Numa VM
menor que o P, ele para antes de mexer em qualquer coisa; numa VM menor que o porte do contrato, para logo depois do
registro e avisa a Verax.

- **Sistema:** Debian 12, Ubuntu 22.04 ou Ubuntu 24.04, x86_64 (amd64), instalação limpa. O instalador instala o Docker
  Engine do repositório oficial da Docker (se a VM já tiver o `docker.io` do sistema, remova-o antes).
- **Acesso:** um usuário com `sudo`. A Verax não pede nem recebe acesso à VM.
- **Swap:** desligado ou cifrado. Na memória do nó ficam a chave do cofre de credenciais e os segredos; com swap em
  claro, eles podem chegar ao disco (e aos snapshots dele). O instalador não mexe no swap da VM. Os nós na Verax usam
  swap cifrado com uma chave nova a cada boot (dm-crypt no modo plain).

## 2. A rede: só saída

A VM **não abre nenhuma porta de entrada**: o painel chega à API pelo túnel do Cloudflare, que é uma conexão de saída.
Libere a saída para:

| Destino                                                               | Porta               | Para quê                                                                   |
| --------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| Cloudflare (`*.argotunnel.com`, `*.cftunnel.com`)                     | 443 e 7844 TCP/UDP  | O túnel da API                                                             |
| `github.com`, `objects.githubusercontent.com`                         | 443                 | O instalador, o manifesto e o pacote da versão                             |
| `ghcr.io`, `pkg-containers.githubusercontent.com`                     | 443                 | As imagens do Verax, pelo digest                                           |
| Docker Hub (`registry-1.docker.io`, `auth.docker.io`, `*.docker.com`) | 443                 | As imagens de terceiros (Wazuh, PostgreSQL, cloudflared) e o apt do Docker |
| `conta.veraxsistemas.com.br`                                          | 443                 | O registro do nó no plano de controle da Verax                             |
| O servidor de e-mail do nó (a Verax informa)                          | a dele (465 ou 587) | Os e-mails do painel (senha, avisos)                                       |
| `api.cloudflare.com` e as APIs das nuvens monitoradas                 | 443                 | A coleta                                                                   |
| Os espelhos do sistema (apt) e o NTP                                  | 80/443 e 123        | Os pacotes do sistema e o relógio                                          |

## 3. Instalar: um comando

O console gera um **código de uso único** (vale 7 dias; gerar outro revoga o anterior) e mostra o comando, com a versão
e o SHA-256 do instalador tirados do manifesto assinado da versão:

```bash
curl -fsSLo verax-install.sh https://github.com/williandotdev/verax-control/releases/download/<versão>/verax-install.sh \
  && echo "<sha256 do instalador>  verax-install.sh" | sha256sum -c - \
  && sudo bash verax-install.sh --codigo <código>
```

O instalador (`infra/node/bin/verax-install.sh`):

1. confere o sistema, a arquitetura e o tamanho da VM;
2. instala o `jq` e o Docker e ajusta o kernel para o indexer do Wazuh (`/etc/sysctl.d/90-verax.conf`);
3. baixa o manifesto da versão e confere a assinatura com as chaves públicas de release **embutidas no instalador**
   (nada em que confiar é baixado), confere que ele mesmo é o instalador que o manifesto descreve, baixa o pacote e
   confere o SHA-256 e as imagens;
4. troca o código pelo registro do nó (`POST https://conta.veraxsistemas.com.br/v1/node-enrollment/claim`): o porte, o
   plano, os endereços, o e-mail do nó, o token do túnel e a chave do nó;
5. grava a configuração (`/etc/verax/node.conf`), o cofre local e as entradas do primeiro acesso e instala o nó;
6. espera o nó, o Wazuh, o primeiro acesso e o túnel (até cerca de 40 minutos na primeira vez, com o download das
   imagens) e entrega à Verax a senha temporária do administrador (`POST .../v1/node-enrollment/report`), que é apagada
   da VM em seguida. A Verax manda o e-mail "ambiente pronto"; no primeiro login, o painel pede uma senha nova e o MFA.

Numa falha depois do registro, o instalador avisa a Verax com um código curto (o console mostra `node_error:<código>`)
e diz na tela o que houve. Para tentar de novo, gere outro código no console e rode o comando novo: o que já está na VM
fica, e a instalação continua de onde parou.

## 4. Atualizar

A Verax avisa a versão nova. Baixe o instalador **dessa versão** (as duas primeiras linhas do comando do console) e
rode:

```bash
sudo bash verax-install.sh --atualizar
```

Ele confere o manifesto e o pacote da versão nova como na instalação, faz um backup do banco antes e reinstala o nó na
versão nova, com os mesmos dados e a mesma configuração. Ele recusa voltar para uma versão mais antiga. Na mesma
versão, não reinstala nada: só conclui um registro que ficou pela metade (a senha temporária que não chegou à Verax).

**Não há volta automática.** O `--atualizar` faz o backup antes, mas, se a versão nova não subir, o nó fica parado na
versão nova e o instalador para com o erro na tela; nada volta sozinho, e o instalador recusa voltar de versão (as
migrations do banco só andam para a frente). Fale com a Verax: a correção é uma versão nova, com o instalador dela e
`--atualizar`. Se for preciso devolver os dados ao estado de antes da atualização, restaure o backup que o
`--atualizar` fez (o `verax-*.dump` da hora da atualização, em `/var/lib/verax/backups`); na partida seguinte, as
migrations da versão instalada rodam de novo sobre ele:

```bash
sudo systemctl stop verax-node            # para o Wazuh, a API, o worker e o túnel; o disco do banco fica
cd /opt/verax
sudo docker compose -f compose.yaml --env-file /etc/verax/images.env --env-file /run/verax/memory.env up -d --wait postgres
sudo docker compose -f compose.yaml --env-file /etc/verax/images.env exec -T postgres \
  pg_restore -U verax -d verax --clean --if-exists --single-transaction </var/lib/verax/backups/verax-<data>.dump
sudo systemctl start verax-node
```

## 5. Diagnóstico

- `sudo systemctl status verax-node verax-wazuh verax-customer-bootstrap` e `sudo journalctl -u verax-node`;
- os backups em `/var/lib/verax/backups` (`verax-backup.timer`, todo dia; a retenção muda com `BACKUP_RETENTION_DAYS`
  no `node.conf`, de 1 a 365 dias);
- o cofre local e o `node.conf` são só do root; nada deles vai para o log.

## 6. Desinstalar (fim do contrato)

No fim do contrato, a Verax apaga o que é dela (o túnel, o endereço, o painel e o cadastro). **A VM é do cliente, e
quem a apaga é ele.** Antes, guarde o que quiser do banco (um backup novo, `sudo /opt/verax/bin/backup.sh`, e uma cópia
de `/var/lib/verax/backups`). Depois, apague a VM e o disco dela ou, para manter a VM:

```bash
sudo systemctl disable --now verax-backup.timer verax-wazuh-alerts.timer verax-wazuh-apply.timer \
  verax-wazuh-apply.path verax-customer-bootstrap.service verax-wazuh.service verax-node.service
sudo systemctl disable verax-vm-metadata-guard.service   # a guarda recusa parar à mão; as regras somem no reboot
sudo docker volume rm $(sudo docker volume ls -q --filter label=com.docker.compose.project=verax)
sudo rm -rf /opt/verax /etc/verax /var/lib/verax /etc/systemd/system/verax-* /etc/sysctl.d/90-verax.conf
sudo systemctl daemon-reload
sudo reboot
```
