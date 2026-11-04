#!/bin/bash
# Peças do workflow `Versão do nó` (.github/workflows/versao-no.yml): o pacote do nó, o manifesto da versão e a
# assinatura no Cloud KMS. Roda na raiz de um clone do repositório (o `package` lê o commit pelo git, não pela pasta).
#
#   node-release.sh package <commit> <saída.tar.gz>
#     O pacote do nó daquele commit, igual byte a byte em qualquer máquina: o que o deploy.sh copia para a VM
#     (infra/node, menos os testes, mais a configuração e os scripts de infra/wazuh que o perfil standard usa), lido
#     dos objetos do git (`git archive`), com data, dono e permissões fixos e o gzip sem nome nem hora. Quem quiser
#     auditar refaz o pacote a partir da tag e compara o SHA-256.
#
#   node-release.sh manifest --commit <c> --release node-vX.Y.Z --api-digest sha256:… --migrate-digest sha256:…
#                            --package <verax-node.tar.gz> --repository <dono/repo>
#     O manifest.json na saída padrão: o commit, a versão, o SHA-256 do pacote, as imagens do Verax no GHCR pelo digest
#     e as imagens de terceiros exatamente como os compose do próprio pacote as fixam (pelo digest). As de terceiros
#     (Wazuh, PostgreSQL, cloudflared) não são copiadas pela Verax: o nó as baixa da origem. Uma imagem de terceiro sem
#     digest no compose, ou uma imagem por variável que não seja a da API ou das migrations, para tudo.
#
#   node-release.sh sign --key-version <projects/…/cryptoKeyVersions/N> --manifest <arquivo> --out <arquivo.sig>
#                        --node-package-dir <pasta verax-node extraída do pacote>
#     Assina o SHA-256 do manifesto com a chave de release no Cloud KMS (asymmetricSign; o token de acesso vem em
#     GOOGLE_ACCESS_TOKEN, nunca em argumento) e só grava a assinatura depois de conferir que a resposta veio dessa
#     versão da chave e que o verificador e as chaves do próprio pacote (bin/verify-release.sh e keys/) a aceitam.
set -euo pipefail
export LC_ALL=C

die() {
  echo "node-release: $*" >&2
  exit 1
}
usage() {
  awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0" >&2
  exit 2
}

commit_re='^[0-9a-f]{40}$'
digest_re='^sha256:[0-9a-f]{64}$'
release_re='^node-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
repository_re='^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'
# Uma referência de imagem de terceiro: nome (com registro opcional), tag opcional e o digest obrigatório.
third_party_re='^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$'
kms_key_version_re='^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/[a-z0-9-]+/keyRings/[A-Za-z0-9_-]{1,63}/cryptoKeys/[A-Za-z0-9_-]{1,63}/cryptoKeyVersions/[1-9][0-9]{0,5}$'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

package() { # <commit> <saída.tar.gz>
  (($# == 2)) || usage
  local commit=$1 out=$2 epoch
  [[ $commit =~ $commit_re ]] || die "commit inválido: $commit"
  git cat-file -e "$commit^{commit}" 2>/dev/null || die "o commit $commit não está neste clone."
  mkdir -p "$work/src" "$work/stage/verax-node/wazuh/config"
  git archive --format=tar "$commit" -- infra/node infra/wazuh/scripts infra/wazuh/config/indexer \
    infra/wazuh/config/manager | tar -x -C "$work/src"
  [[ -f $work/src/infra/node/bin/install.sh ]] || die "o commit $commit não tem o pacote do nó (infra/node)."
  cp -R "$work/src/infra/node/." "$work/stage/verax-node/"
  rm -rf "$work/stage/verax-node/tests"
  cp -R "$work/src/infra/wazuh/scripts" "$work/stage/verax-node/wazuh/"
  cp -R "$work/src/infra/wazuh/config/indexer" "$work/src/infra/wazuh/config/manager" "$work/stage/verax-node/wazuh/config/"
  # Data do commit em tudo, dono root, permissões sem escrita para grupo e outros (o executável continua executável),
  # ordem por nome e sem atime/ctime: o mesmo commit dá sempre os mesmos bytes (reproducible-builds.org, "Archives").
  epoch=$(git show -s --format=%ct "$commit")
  tar --sort=name --format=posix --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' \
    -C "$work/stage" -cf - verax-node | gzip -9n >"$work/package.tar.gz"
  mv "$work/package.tar.gz" "$out"
}

manifest() {
  local commit='' release='' api_digest='' migrate_digest='' package_file='' repository=''
  while (($#)); do
    (($# >= 2)) || usage
    case $1 in
      --commit) commit=$2 ;;
      --release) release=$2 ;;
      --api-digest) api_digest=$2 ;;
      --migrate-digest) migrate_digest=$2 ;;
      --package) package_file=$2 ;;
      --repository) repository=$2 ;;
      *) usage ;;
    esac
    shift 2
  done
  [[ $commit =~ $commit_re ]] || die "commit inválido: $commit"
  [[ $release =~ $release_re ]] || die "versão inválida: $release (use node-vX.Y.Z)"
  [[ $api_digest =~ $digest_re && $migrate_digest =~ $digest_re ]] || die 'digests inválidos (sha256:<64 hexadecimais>).'
  [[ $repository =~ $repository_re ]] || die "repositório inválido: $repository"
  [[ -f $package_file ]] || die "pacote não encontrado: $package_file"

  local sha composes compose images third=() ref
  sha=$(sha256sum "$package_file" | cut -d' ' -f1)
  mapfile -t composes < <(tar -tzf "$package_file" | grep -E '^verax-node/compose[A-Za-z0-9.-]*\.yaml$' | sort)
  ((${#composes[@]} > 0)) || die 'o pacote não tem compose.'
  for compose in "${composes[@]}"; do
    images=$(tar -xzOf "$package_file" "$compose" |
      sed -nE 's/^[[:space:]]*image:[[:space:]]*//p' | sed -E 's/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\'']?[[:space:]]*$//')
    while IFS= read -r ref; do
      [[ -n $ref ]] || continue
      # shellcheck disable=SC2016 # os padrões são o texto literal do compose
      case $ref in
        # As duas imagens do Verax: o install.sh escreve as variáveis com o registro e o digest conferidos.
        '${API_IMAGE:?}' | '${MIGRATE_IMAGE:?}') ;;
        '$'*) die "${compose#verax-node/}: imagem por variável que o manifesto não cobre: $ref" ;;
        *)
          [[ $ref =~ $third_party_re ]] || die "${compose#verax-node/}: imagem de terceiro sem digest fixo: $ref"
          third+=("$ref")
          ;;
      esac
    done <<<"$images"
  done
  ((${#third[@]} > 0)) || die 'nenhuma imagem de terceiro nos compose do pacote.'

  local repo_lower=${repository,,}
  printf '%s\n' "${third[@]}" | sort -u | jq -R . | jq -s \
    --arg commit "$commit" \
    --arg release "$release" \
    --arg released_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg url "https://github.com/$repository/releases/download/$release/verax-node.tar.gz" \
    --arg sha "$sha" \
    --arg api "ghcr.io/$repo_lower/api@$api_digest" \
    --arg migrate "ghcr.io/$repo_lower/migrate@$migrate_digest" \
    --arg notes "https://github.com/$repository/releases/tag/$release" \
    '{
      schema: 1,
      kind: "verax-node-release",
      version: $commit,
      release: $release,
      releasedAt: $released_at,
      package: {url: $url, sha256: $sha},
      images: {api: $api, migrate: $migrate},
      thirdPartyImages: .,
      notes: $notes
    }'
}

sign() {
  local key_version='' manifest_file='' out='' package_dir=''
  while (($#)); do
    (($# >= 2)) || usage
    case $1 in
      --key-version) key_version=$2 ;;
      --manifest) manifest_file=$2 ;;
      --out) out=$2 ;;
      --node-package-dir) package_dir=$2 ;;
      *) usage ;;
    esac
    shift 2
  done
  [[ $key_version =~ $kms_key_version_re ]] || die 'versão da chave do KMS inválida (projects/…/cryptoKeyVersions/N).'
  [[ -f $manifest_file ]] || die "manifesto não encontrado: $manifest_file"
  [[ -n $out ]] || usage
  [[ -f $package_dir/bin/verify-release.sh ]] || die 'o pacote não traz o verificador (bin/verify-release.sh).'
  [[ -n ${GOOGLE_ACCESS_TOKEN:-} ]] || die 'falta GOOGLE_ACCESS_TOKEN.'

  local digest response name signature tmp=$work/manifest.sig
  digest=$(openssl dgst -sha256 -binary "$manifest_file" | base64 | tr -d '\n')
  # O token vai num cabeçalho lido de um descritor (printf é interno do bash): não aparece na linha de comando de
  # nenhum processo. Só HTTPS, com prazo.
  response=$(curl -fsS --proto '=https' --max-time 60 --retry 3 --retry-all-errors -X POST \
    -H @<(printf 'Authorization: Bearer %s\n' "$GOOGLE_ACCESS_TOKEN") \
    -H 'Content-Type: application/json' \
    --data "{\"digest\":{\"sha256\":\"$digest\"}}" \
    "https://cloudkms.googleapis.com/v1/$key_version:asymmetricSign") || die 'o Cloud KMS recusou a assinatura.'
  # A resposta diz qual versão da chave assinou ("Check this field to verify that the intended resource was used").
  name=$(jq -er '.name | strings' <<<"$response" 2>/dev/null) || die 'resposta do Cloud KMS sem a versão da chave.'
  [[ $name == "$key_version" ]] || die "o Cloud KMS assinou com outra versão da chave: $name"
  signature=$(jq -er '.signature | strings' <<<"$response" 2>/dev/null) || die 'resposta do Cloud KMS sem assinatura.'
  [[ $signature =~ ^[A-Za-z0-9+/]{8,200}={0,2}$ ]] || die 'assinatura do Cloud KMS fora do formato (base64).'

  base64 -d <<<"$signature" >"$tmp" || die 'assinatura do Cloud KMS que não decodifica.'
  bash "$package_dir/bin/verify-release.sh" "$manifest_file" "$tmp" >&2 ||
    die 'a assinatura não fecha com as chaves do pacote (keys/release-*.pem): a pública desta versão da chave está no commit?'
  mv "$tmp" "$out"
}

(($# >= 1)) || usage
command=$1
shift
case $command in
  package) package "$@" ;;
  manifest) manifest "$@" ;;
  sign) sign "$@" ;;
  *) usage ;;
esac
