#!/bin/bash
# Guarda do servidor de metadados da nuvem para os contêineres do nó na VM própria do cliente (NODE_PLATFORM=vm). Na
# AWS, no Azure, na GCP e em outras nuvens, o metadata da instância responde em 169.254.169.254 (na AWS também em
# fd00:ec2::254, pelo IPv6) e entrega as credenciais da identidade da VM. No modo vm, nenhum contêiner do nó usa a
# identidade da nuvem: todos ficam sem acesso, o worker também (é a diferença para o metadata-guard.sh dos nós da GCP,
# que este não substitui nem toca). O host continua com acesso: a regra está na cadeia DOCKER-USER, que só vê o tráfego
# que sai dos contêineres. A porta 53 do mesmo endereço segue liberada: é o DNS da VM na GCP, e o DNS embutido do Docker
# resolve por ele de dentro da rede dos contêineres.
#
# Roda como root, duas vezes: pelo verax-vm-metadata-guard.service, antes de o Docker subir (as regras não sobrevivem a
# um reboot, e o Docker recriaria os contêineres com `restart` antes de qualquer guarda), e de novo no `start.sh up`,
# que só reafirma. Idempotente. O conteúdo da cadeia entra numa transação só do iptables-restore (esvaziar e preencher
# num commit): com contêineres no ar, não há instante em que a cadeia esteja vazia. Com o ip6tables na VM, o mesmo para
# o IPv6.
set -euo pipefail

chain=VERAX-IMDS

guard() { # <iptables | ip6tables> <endereço do metadata>
  local tool=$1 address=$2
  # O Docker, ao subir, só acrescenta o RETURN dele no fim do DOCKER-USER e nunca mexe no que já está na cadeia.
  "$tool" -N DOCKER-USER 2>/dev/null || true
  "$tool-restore" --noflush <<EOF
*filter
:$chain - [0:0]
-F $chain
-A $chain -p udp --dport 53 -j RETURN
-A $chain -p tcp --dport 53 -j RETURN
-A $chain -j DROP
COMMIT
EOF
  "$tool" -C DOCKER-USER -d "$address" -j "$chain" 2>/dev/null ||
    "$tool" -I DOCKER-USER 1 -d "$address" -j "$chain"
}

guard iptables 169.254.169.254
if command -v ip6tables >/dev/null && ip6tables -S >/dev/null 2>&1; then
  guard ip6tables fd00:ec2::254
fi
