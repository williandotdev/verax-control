#!/bin/bash
# Roda a cada boot da VM do nó. Só prepara o disco de dados em /var/lib/verax: formata se ele ainda não tiver
# sistema de arquivos (primeira vez) e monta. Reiniciar a VM nunca apaga dado.
set -euo pipefail

DEVICE=/dev/disk/by-id/google-verax-data
MOUNT_POINT=/var/lib/verax

# blkid devolve 2 quando o disco não tem sistema de arquivos: só nesse caso ele é formatado.
if ! blkid "$DEVICE" >/dev/null 2>&1; then
  mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard -L verax-data "$DEVICE"
fi

mkdir -p "$MOUNT_POINT"
if ! grep -q "LABEL=verax-data" /etc/fstab; then
  echo "LABEL=verax-data $MOUNT_POINT ext4 discard,defaults,nofail 0 2" >>/etc/fstab
fi
mountpoint -q "$MOUNT_POINT" || mount "$MOUNT_POINT"
