#!/bin/bash
# Guarda do servidor de metadados da GCP (169.254.169.254) para os contêineres do nó. Só o worker fala com ele, que
# entrega o token da VM (leitura das assinaturas, dos segredos e dos backups). A API (exposta pelo túnel), o
# cloudflared, o banco e, no standard, o manager e o indexer do Wazuh (que processam log de fora) ficam sem acesso: uma
# falha num deles não vira o token da VM. O DNS da GCE usa o mesmo IP, na porta 53, e segue liberado para todos.
#
# Roda como root, duas vezes: pelo verax-metadata-guard.service, antes de o Docker subir (as regras não sobrevivem a
# um reboot, e sem isso o Docker recriaria os contêineres com `restart` antes de qualquer guarda), e de novo no
# `start.sh up`, que só reafirma. A cadeia DOCKER-USER é criada aqui se ainda não existe: o Docker, ao subir, só
# acrescenta o `RETURN` dele no fim e o salto do FORWARD, e nunca mexe no que já está nela.
#
# A regra vale para o tráfego de qualquer contêiner (sem `-s`; o DOCKER-USER só vê o que sai dos contêineres): as redes
# do Wazuh ficam fora de NODE_SUBNET. O conteúdo da cadeia VERAX-METADATA entra numa transação só do iptables-restore
# (esvaziar e preencher num commit): com contêineres no ar, não há instante em que a cadeia esteja vazia e o salto do
# DOCKER-USER a alcance. A regra antiga, só de NODE_SUBNET, sai depois que a nova está no lugar.
set -euo pipefail

# Rede dos contêineres e o IP do worker: os mesmos do compose.yaml (o CI confere).
NODE_SUBNET=172.30.53.0/24
WORKER_IP=172.30.53.10
chain=VERAX-METADATA

iptables -N DOCKER-USER 2>/dev/null || true
iptables-restore --noflush <<EOF
*filter
:$chain - [0:0]
-F $chain
-A $chain -s $WORKER_IP -j RETURN
-A $chain -p udp --dport 53 -j RETURN
-A $chain -p tcp --dport 53 -j RETURN
-A $chain -j DROP
COMMIT
EOF
iptables -C DOCKER-USER -d 169.254.169.254 -j "$chain" 2>/dev/null ||
  iptables -I DOCKER-USER 1 -d 169.254.169.254 -j "$chain"
while iptables -D DOCKER-USER -s "$NODE_SUBNET" -d 169.254.169.254 -j "$chain" 2>/dev/null; do :; done
