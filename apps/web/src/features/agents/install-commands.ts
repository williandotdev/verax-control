import {
  type AgentPackageKind,
  WAZUH_AGENT_GROUP,
  WAZUH_AGENT_PACKAGES,
  WAZUH_AGENT_VERSION,
} from '@verax/shared';

/**
 * Scripts de instalação do agente do Wazuh, montados no navegador com o que a API devolve (o IP fixo do manager, a CA
 * do registro e, para quem administra, a senha de registro). Seguem a documentação do Wazuh 4.14 (variáveis de
 * implantação WAZUH_MANAGER, WAZUH_REGISTRATION_SERVER, WAZUH_REGISTRATION_PASSWORD, WAZUH_REGISTRATION_CA e
 * WAZUH_AGENT_GROUP; serviços `wazuh-agent` e `WazuhSvc`), com três cuidados a mais:
 * - o pacote oficial da versão do manager é baixado e conferido pelo SHA-512 publicado pela Wazuh antes de instalar;
 * - a CA do registro vai para a instância, e o agente confere o manager (o IP fixo no certificado) antes de mandar a
 *   senha;
 * - nenhum repositório é acrescentado: o agente não sobe de versão sozinho (o manager recusa agente mais novo).
 * Os valores que entram no script têm formato conferido pelo schema da resposta (IPv4, letras e dígitos, PEM): nada
 * precisa de escape.
 */

export interface InstallInputs {
  managerAddress: string;
  caCertificate: string;
  /** Null: quem não administra vê o lugar da senha, para quem administra preencher. */
  enrollmentPassword: string | null;
}

/** O que aparece no lugar da senha quando ela não está à mostra (ou quando quem vê não pode tê-la). */
export const ENROLLMENT_PLACEHOLDER = '<SENHA-DE-REGISTRO>';
export const ENROLLMENT_MASK = '••••••••••••••••';

export type LinuxFamily = 'deb' | 'rpm';
export type LinuxArch = 'x86_64' | 'arm64';

const LINUX_PACKAGE: Readonly<Record<LinuxFamily, Record<LinuxArch, AgentPackageKind>>> = {
  deb: { x86_64: 'deb-amd64', arm64: 'deb-arm64' },
  rpm: { x86_64: 'rpm-x86_64', arm64: 'rpm-aarch64' },
};

const LINUX_INSTALLER: Readonly<Record<LinuxFamily, string>> = { deb: 'dpkg -i', rpm: 'rpm -ivh' };

/** Onde a CA fica na instância Linux (a pasta de configuração do agente, que o pacote cria). */
export const LINUX_CA_PATH = '/var/ossec/etc/verax-ca.pem';
/** No Windows, o caminho relativo à pasta do agente, como a documentação do Wazuh indica para WAZUH_REGISTRATION_CA. */
export const WINDOWS_CA_FILE = 'verax-ca.pem';

function pem(certificate: string): string {
  return certificate.trim();
}

/** Script para Linux: salvar como arquivo e rodar com `sudo bash`. */
export function linuxScript(
  inputs: InstallInputs,
  family: LinuxFamily,
  arch: LinuxArch,
  enrollment: string = inputs.enrollmentPassword ?? ENROLLMENT_PLACEHOLDER,
): string {
  const pkg = WAZUH_AGENT_PACKAGES[LINUX_PACKAGE[family][arch]];
  const address = inputs.managerAddress;
  return [
    '#!/bin/bash',
    `# Agente do Wazuh ${WAZUH_AGENT_VERSION} para o Verax Control (${family === 'deb' ? 'Debian e Ubuntu' : 'RHEL, Amazon Linux, Rocky e Alma'}, ${arch}).`,
    '# Rode como root: sudo bash instalar-agente-verax.sh',
    'set -euo pipefail',
    `package=/tmp/${pkg.file}`,
    `curl -fsSL -o "$package" ${pkg.url}`,
    `echo "${pkg.sha512}  $package" | sha512sum -c -`,
    `WAZUH_MANAGER='${address}' WAZUH_REGISTRATION_SERVER='${address}' \\`,
    `  WAZUH_REGISTRATION_PASSWORD='${enrollment}' \\`,
    `  WAZUH_REGISTRATION_CA='${LINUX_CA_PATH}' WAZUH_AGENT_GROUP='${WAZUH_AGENT_GROUP}' \\`,
    `  ${LINUX_INSTALLER[family]} "$package"`,
    `cat >${LINUX_CA_PATH} <<'CA'`,
    pem(inputs.caCertificate),
    'CA',
    `chown root:wazuh ${LINUX_CA_PATH}`,
    `chmod 0640 ${LINUX_CA_PATH}`,
    'systemctl daemon-reload',
    'systemctl enable --now wazuh-agent',
    'rm -f "$package"',
    '',
  ].join('\n');
}

/** Script para Windows: colar no PowerShell aberto como administrador. */
export function windowsScript(
  inputs: InstallInputs,
  enrollment: string = inputs.enrollmentPassword ?? ENROLLMENT_PLACEHOLDER,
): string {
  const pkg = WAZUH_AGENT_PACKAGES.msi;
  const address = inputs.managerAddress;
  return [
    `# Agente do Wazuh ${WAZUH_AGENT_VERSION} para o Verax Control (Windows). Cole no PowerShell aberto como administrador.`,
    "$ErrorActionPreference = 'Stop'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    `$package = Join-Path $env:TEMP '${pkg.file}'`,
    `Invoke-WebRequest -UseBasicParsing -Uri '${pkg.url}' -OutFile $package`,
    `if ((Get-FileHash -Algorithm SHA512 $package).Hash -ne '${pkg.sha512}') { throw 'O SHA-512 do pacote não confere.' }`,
    '$install = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(',
    `  '/i', "\`"$package\`"", '/q', 'WAZUH_MANAGER=${address}', 'WAZUH_REGISTRATION_SERVER=${address}',`,
    `  'WAZUH_REGISTRATION_PASSWORD=${enrollment}', 'WAZUH_REGISTRATION_CA=${WINDOWS_CA_FILE}',`,
    `  'WAZUH_AGENT_GROUP=${WAZUH_AGENT_GROUP}')`,
    'if ($install.ExitCode -ne 0) { throw "O instalador saiu com o código $($install.ExitCode)." }',
    "$ca = @'",
    pem(inputs.caCertificate),
    "'@",
    `Set-Content -Path (Join-Path \${env:ProgramFiles(x86)} 'ossec-agent\\${WINDOWS_CA_FILE}') -Value $ca -Encoding ascii`,
    'Start-Service WazuhSvc',
    'Remove-Item $package',
    '',
  ].join('\n');
}
