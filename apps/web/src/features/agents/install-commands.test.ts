import { WAZUH_AGENT_PACKAGES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  ENROLLMENT_MASK,
  ENROLLMENT_PLACEHOLDER,
  type InstallInputs,
  linuxScript,
  windowsScript,
} from './install-commands';

const CA = '-----BEGIN CERTIFICATE-----\nQ0EgZGUgdGVzdGU=\n-----END CERTIFICATE-----\n';
// Fictícia, letras e dígitos como a do nó.
const ENROLLMENT = 'Teste0Agentes0Verax0Control00000';
const inputs: InstallInputs = {
  managerAddress: '203.0.113.10',
  caCertificate: CA,
  enrollmentPassword: ENROLLMENT,
};

describe('scripts de instalação do agente', () => {
  it('Linux (deb, x86_64): pacote oficial conferido pelo SHA-512, variáveis do Wazuh, CA e serviço', () => {
    const script = linuxScript(inputs, 'deb', 'x86_64');
    const pkg = WAZUH_AGENT_PACKAGES['deb-amd64'];
    expect(script.startsWith('#!/bin/bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain(`curl -fsSL -o "$package" ${pkg.url}`);
    expect(script).toContain(`echo "${pkg.sha512}  $package" | sha512sum -c -`);
    expect(script).toContain("WAZUH_MANAGER='203.0.113.10' WAZUH_REGISTRATION_SERVER='203.0.113.10'");
    expect(script).toContain(`WAZUH_REGISTRATION_PASSWORD='${ENROLLMENT}'`);
    expect(script).toContain(
      "WAZUH_REGISTRATION_CA='/var/ossec/etc/verax-ca.pem' WAZUH_AGENT_GROUP='default'",
    );
    expect(script).toContain('  dpkg -i "$package"');
    expect(script).toContain("cat >/var/ossec/etc/verax-ca.pem <<'CA'\n-----BEGIN CERTIFICATE-----");
    expect(script).toContain('-----END CERTIFICATE-----\nCA\n');
    expect(script).toContain('systemctl enable --now wazuh-agent');
    // A verificação vem antes da instalação: um pacote trocado nunca chega ao dpkg.
    expect(script.indexOf('sha512sum -c')).toBeLessThan(script.indexOf('dpkg -i'));
  });

  it('Linux (rpm, ARM64): o pacote aarch64 e o rpm', () => {
    const script = linuxScript(inputs, 'rpm', 'arm64');
    expect(script).toContain(WAZUH_AGENT_PACKAGES['rpm-aarch64'].url);
    expect(script).toContain(WAZUH_AGENT_PACKAGES['rpm-aarch64'].sha512);
    expect(script).toContain('  rpm -ivh "$package"');
    expect(script).not.toContain('dpkg');
  });

  it('Windows: MSI oficial conferido pelo SHA-512, msiexec com as variáveis, CA na pasta do agente e WazuhSvc', () => {
    const script = windowsScript(inputs);
    const pkg = WAZUH_AGENT_PACKAGES.msi;
    expect(script).toContain(`Invoke-WebRequest -UseBasicParsing -Uri '${pkg.url}' -OutFile $package`);
    expect(script).toContain(`(Get-FileHash -Algorithm SHA512 $package).Hash -ne '${pkg.sha512}'`);
    expect(script).toContain("'WAZUH_MANAGER=203.0.113.10', 'WAZUH_REGISTRATION_SERVER=203.0.113.10'");
    expect(script).toContain(
      `'WAZUH_REGISTRATION_PASSWORD=${ENROLLMENT}', 'WAZUH_REGISTRATION_CA=verax-ca.pem'`,
    );
    expect(script).toContain("'WAZUH_AGENT_GROUP=default')");
    // O here-string do PowerShell fecha na coluna 0.
    expect(script).toContain("$ca = @'\n-----BEGIN CERTIFICATE-----");
    expect(script).toContain("-----END CERTIFICATE-----\n'@\n");
    expect(script).toContain("Join-Path ${env:ProgramFiles(x86)} 'ossec-agent\\verax-ca.pem'");
    expect(script).toContain('Start-Service WazuhSvc');
    expect(script.indexOf('Get-FileHash')).toBeLessThan(script.indexOf('msiexec'));
  });

  it('sem a senha (quem não administra), o lugar dela fica marcado; mascarada, só a máscara aparece', () => {
    const withoutPassword = { ...inputs, enrollmentPassword: null };
    expect(linuxScript(withoutPassword, 'deb', 'x86_64')).toContain(
      `WAZUH_REGISTRATION_PASSWORD='${ENROLLMENT_PLACEHOLDER}'`,
    );
    expect(windowsScript(withoutPassword)).toContain(
      `'WAZUH_REGISTRATION_PASSWORD=${ENROLLMENT_PLACEHOLDER}'`,
    );
    const masked = linuxScript(inputs, 'deb', 'x86_64', ENROLLMENT_MASK);
    expect(masked).not.toContain(ENROLLMENT);
    expect(masked).toContain(ENROLLMENT_MASK);
  });
});
