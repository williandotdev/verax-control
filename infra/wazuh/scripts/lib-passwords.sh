#!/usr/bin/env bash
# Formato das senhas do Wazuh, o mesmo em todo caminho: o deploy.sh (EC2) confere as que recebe; no nó de cliente, o
# install.sh gera as senhas nesse formato e o start.sh confere as senhas reais (/var/lib/verax/secrets) a cada partida;
# o ci-test.sh gera e confere as dele do mesmo jeito.
#
# Aceito por todos os componentes sem escape: a API do Wazuh exige maiúscula, minúscula, dígito e símbolo, e os
# scripts de init das imagens gravam as senhas com sed, entre aspas simples, em YAML.

# wazuh_password_ok <valor>: de 32 a 64 caracteres, começa por letra, só letras, dígitos, `.` e `-`, com maiúscula,
# minúscula, dígito e símbolo.
wazuh_password_ok() {
  [[ $1 =~ ^[A-Za-z][A-Za-z0-9.-]{31,63}$ && $1 =~ [a-z] && $1 =~ [A-Z] && $1 =~ [0-9] && $1 =~ [.-] ]]
}

# new_wazuh_password: uma senha nova no formato, com 40 caracteres tirados de /dev/urandom (mais de 230 bits). O corte
# é feito pelo bash, e não por um `head` no fim do pipe, que poderia derrubar o `tr` com SIGPIPE sob `pipefail`.
new_wazuh_password() {
  local value=''
  until wazuh_password_ok "$value"; do
    value=$(head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9.-')
    value=${value:0:40}
  done
  printf '%s' "$value"
}

# check_wazuh_passwords <variável...>: cada variável (pelo nome) no formato, e todas diferentes entre si. As mensagens
# citam só os nomes, nunca os valores.
check_wazuh_passwords() {
  local name values=()
  for name in "$@"; do
    if ! wazuh_password_ok "${!name:-}"; then
      echo "ERRO: $name deve ter de 32 a 64 caracteres, começar por letra, usar só letras, dígitos, '.' e '-'" \
        "e ter maiúscula, minúscula, dígito e símbolo." >&2
      return 1
    fi
    values+=("${!name}")
  done
  if (($(printf '%s\n' "${values[@]}" | sort -u | wc -l) != $#)); then
    echo "ERRO: as senhas do Wazuh ($*) devem ser diferentes." >&2
    return 1
  fi
}
