#!/bin/bash
# Roda a cada boot da VM do nó. Só prepara a VM: a pasta dos dados do nó e 2 GB de memória de troca, porque a
# e2-micro tem 1 GB de RAM. Não apaga nem reinstala nada: cada passo confere se já foi feito.
set -euo pipefail

mkdir -p /var/lib/verax
chmod 0750 /var/lib/verax

SWAPFILE=/swapfile
if [ ! -f "$SWAPFILE" ]; then
  fallocate -l 2G "$SWAPFILE"
  chmod 0600 "$SWAPFILE"
  mkswap "$SWAPFILE"
fi
if ! grep -q "^$SWAPFILE " /etc/fstab; then
  echo "$SWAPFILE none swap sw 0 0" >>/etc/fstab
fi
swapon --show=NAME --noheadings | grep -qx "$SWAPFILE" || swapon "$SWAPFILE"
