import { type Agent, type AgentInstall, WAZUH_AGENT_VERSION } from '@verax/shared';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { SelectField } from '@/components/ui/select-field';
import { AdminShell } from '@/features/admin/admin-ui';
import { useAgentInstall, useAgents } from '@/features/agents/agents-api';
import { AGENT_STATUS_LABELS, agentListIsStale } from '@/features/agents/labels';
import {
  ENROLLMENT_MASK,
  type InstallInputs,
  type LinuxArch,
  linuxScript,
  windowsScript,
} from '@/features/agents/install-commands';
import { useMe } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { formatRelative, formatTimestamp } from '@/lib/format';

const PAGE_SIZE = 25;

const PLATFORMS = ['deb', 'rpm', 'windows'] as const;
type Platform = (typeof PLATFORMS)[number];
const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
  deb: 'Linux (deb)',
  rpm: 'Linux (rpm)',
  windows: 'Windows',
};

/**
 * Agentes do Wazuh nas instâncias do cliente: a instalação guiada (Linux e Windows) e a lista dos agentes, com o
 * estado de cada um. Os agentes falam com o manager do nó dedicado do cliente, num IP fixo, só a partir das faixas de IP
 * de saída que o cliente informou à Verax. A senha de registro só aparece para quem administra, e cada consulta às
 * instruções fica na trilha de auditoria.
 */
export function AgentsPage() {
  const { data: me } = useMe();
  const hasTenant = me?.scopeTenantId != null;
  return (
    <AdminShell
      title="Agentes"
      description="Agentes do Wazuh nas suas VMs e instâncias EC2: integridade de arquivos, inventário, vulnerabilidades e configuração das máquinas, no mesmo painel das suas contas cloud."
    >
      {hasTenant && <AgentsContent />}
    </AdminShell>
  );
}

function AgentsContent() {
  const install = useAgentInstall(true);
  if (install.isError) {
    return <ErrorState error={install.error} onRetry={() => void install.refetch()} />;
  }
  if (!install.data) return <LoadingState rows={4} label="Carregando as instruções" />;
  const data = install.data;
  if (data.status === 'disabled') return <DisabledNotice />;
  return (
    <div className="space-y-6">
      {data.status === 'allowlist_pending' ? (
        <AllowlistPending install={data} />
      ) : (
        <GuidedInstall install={data} />
      )}
      <AgentList />
    </div>
  );
}

function DisabledNotice() {
  return (
    <Card aria-labelledby="agentes-desligados">
      <CardTitle id="agentes-desligados">Os agentes não estão ligados neste ambiente</CardTitle>
      <div className="mt-2 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          Com eles, o Wazuh do seu ambiente recebe os eventos das suas máquinas, além dos logs das contas
          cloud. Para ligar, peça ao suporte da Verax pelo canal de atendimento do seu contrato, informando os
          IPs (ou faixas) de saída das instâncias que vão ter o agente.
        </p>
        <p>
          A Verax reserva um IP fixo para o seu ambiente e libera as portas 1514 e 1515 só para esses IPs.
          Nada fica aberto para o resto da internet.
        </p>
      </div>
    </Card>
  );
}

function AllowlistPending({ install }: { install: AgentInstall }) {
  return (
    <Card aria-labelledby="liberacao-pendente">
      <CardTitle id="liberacao-pendente">Falta liberar os IPs de saída das suas instâncias</CardTitle>
      <div className="mt-2 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          Os agentes estão ligados no seu ambiente, no IP{' '}
          <code className="font-mono text-foreground">{install.managerAddress}</code>, mas as portas 1514 e
          1515 ficam fechadas até a liberação.
        </p>
        <p>
          Envie ao suporte da Verax os IPs (ou faixas, de /16 a /32) de onde as suas instâncias saem para a
          internet: o NAT gateway ou os IPs elásticos da AWS, o Cloud NAT da GCP, o IP público da sua rede.
          Depois da liberação, as instruções de instalação aparecem aqui.
        </p>
      </div>
    </Card>
  );
}

function GuidedInstall({ install }: { install: AgentInstall }) {
  const [params, setParams] = useSearchParams();
  const platform = PLATFORMS.find((value) => value === params.get('sistema')) ?? 'deb';
  const [arch, setArch] = useState<LinuxArch>('x86_64');
  const [revealed, setRevealed] = useState(false);
  const inputs: InstallInputs = {
    managerAddress: install.managerAddress ?? '',
    caCertificate: install.caCertificate ?? '',
    enrollmentPassword: install.enrollmentPassword,
  };
  // Na tela, a senha fica mascarada até "Mostrar senha"; o botão de copiar leva o script com a senha de verdade.
  const shown = install.enrollmentPassword !== null && !revealed ? ENROLLMENT_MASK : undefined;
  const script = (enrollment?: string) =>
    platform === 'windows'
      ? windowsScript(inputs, enrollment)
      : linuxScript(inputs, platform, arch, enrollment);

  return (
    <section aria-labelledby="instalacao" className="space-y-4">
      <h2 id="instalacao" className="text-lg font-semibold">
        Instalação guiada
      </h2>
      <Card aria-labelledby="antes-de-comecar">
        <CardTitle id="antes-de-comecar">Antes de começar</CardTitle>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>
            A instância precisa sair para <code className="font-mono">{install.managerAddress}</code> nas
            portas TCP {install.eventsPort} (eventos) e {install.enrollmentPort} (registro), a partir de um
            destes IPs:{' '}
            {install.allowedSources.map((source, index) => (
              <span key={source}>
                {index > 0 && ', '}
                <code className="font-mono">{source}</code>
              </span>
            ))}
            .
          </li>
          <li>
            O agente é o Wazuh {WAZUH_AGENT_VERSION}, a mesma versão do seu ambiente. O script baixa o pacote
            oficial, confere o SHA-512 publicado pela Wazuh e não acrescenta repositório: o agente não muda de
            versão sozinho.
          </li>
          <li>
            O agente confere o certificado do seu ambiente antes de mandar a senha de registro (a CA vai no
            script).
          </li>
          <li>
            {install.registered} de {install.maxAgents} agentes registrados neste ambiente.
          </li>
        </ul>
      </Card>

      <EnrollmentPassword
        install={install}
        revealed={revealed}
        onToggle={() => setRevealed((value) => !value)}
      />

      <Tabs.Root
        value={platform}
        onValueChange={(value) =>
          setParams((previous) => {
            const next = new URLSearchParams(previous);
            if (value === 'deb') next.delete('sistema');
            else next.set('sistema', value);
            return next;
          })
        }
      >
        <Tabs.List aria-label="Sistema da instância" className="flex flex-wrap gap-1 border-b">
          {PLATFORMS.map((value) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground"
            >
              {PLATFORM_LABELS[value]}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value={platform} className="space-y-3 pt-4 focus:outline-none">
          {platform !== 'windows' && (
            <SelectField
              label="Arquitetura"
              value={arch}
              onChange={(value) => setArch(value === 'arm64' ? 'arm64' : 'x86_64')}
              options={[
                { value: 'x86_64', label: 'x86_64 (Intel e AMD)' },
                { value: 'arm64', label: 'ARM64 (Graviton, Ampere)' },
              ]}
            />
          )}
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {platform === 'windows' ? (
              <>
                <li>Abra o PowerShell como administrador.</li>
                <li>Cole o script abaixo e confirme. Ele instala, registra e liga o serviço WazuhSvc.</li>
              </>
            ) : (
              <>
                <li>
                  Salve o script abaixo na instância como{' '}
                  <code className="font-mono">instalar-agente-verax.sh</code>.
                </li>
                <li>
                  Rode <code className="font-mono">sudo bash instalar-agente-verax.sh</code>. Ele instala,
                  registra e liga o serviço wazuh-agent.
                </li>
              </>
            )}
            <li>Em até um minuto, a instância aparece na lista abaixo como &quot;Conectado&quot;.</li>
          </ol>
          <ScriptBlock
            display={script(shown)}
            copy={script()}
            label={`Script de instalação para ${PLATFORM_LABELS[platform]}`}
          />
          <p className="text-xs text-muted-foreground">
            A senha de registro vai dentro do script. Apague o arquivo depois de rodar, e não o guarde em
            repositório.
          </p>
        </Tabs.Content>
      </Tabs.Root>

      <Card aria-labelledby="em-escala">
        <CardTitle id="em-escala">Em muitas máquinas de uma vez</CardTitle>
        <CardDescription className="mt-2 space-y-2">
          <span className="block">
            Na AWS, rode o mesmo script pelo Systems Manager (Run Command, com os documentos
            AWS-RunShellScript e AWS-RunPowerShellScript), escolhendo as instâncias por tag. Na GCP, use o VM
            Manager (OS Config) com uma política de SO que rode o script nas VMs certas.
          </span>
          <span className="block">
            Nos dois, a senha de registro fica no histórico do comando: guarde-a num parâmetro seguro
            (Parameter Store do tipo SecureString ou Secret Manager) e leia-a dentro do script.
          </span>
        </CardDescription>
      </Card>
    </section>
  );
}

function EnrollmentPassword({
  install,
  revealed,
  onToggle,
}: {
  install: AgentInstall;
  revealed: boolean;
  onToggle: () => void;
}) {
  const valueId = useId();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (!install.canEnroll) {
    return (
      <p className="rounded-md border p-3 text-sm">
        Só quem administra o ambiente vê a senha de registro. Peça a essa pessoa para rodar o script, ou para
        preencher a senha no lugar de <code className="font-mono">&lt;SENHA-DE-REGISTRO&gt;</code>.
      </p>
    );
  }
  if (install.enrollmentPassword === null) {
    return (
      <p role="alert" className="rounded-md border border-high/60 bg-high/10 p-3 text-sm">
        O ambiente chegou ao limite de {install.maxAgents} agentes. Para registrar outros, fale com o suporte
        da Verax (o limite faz parte do plano).
      </p>
    );
  }
  const password = install.enrollmentPassword;
  const copyPassword = () => {
    const writing = navigator.clipboard?.writeText(password);
    if (writing === undefined) {
      setCopy('failed');
      return;
    }
    void writing.then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  };
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Senha de registro</p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          id={valueId}
          className="break-all rounded-md border bg-surface-raised px-3 py-2 font-mono text-sm"
        >
          {revealed ? password : ENROLLMENT_MASK}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={revealed}
          aria-controls={valueId}
          onClick={onToggle}
        >
          {revealed ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {revealed ? 'Esconder senha' : 'Mostrar senha'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copyPassword}
          aria-label="Copiar a senha de registro"
        >
          <Copy aria-hidden />
          {copy === 'copied' ? 'Copiada' : 'Copiar'}
        </Button>
      </div>
      <p aria-live="polite" className={copy === 'failed' ? 'text-xs text-critical-text' : 'sr-only'}>
        {copy === 'copied' && 'Senha copiada.'}
        {copy === 'failed' && 'Não foi possível copiar. Mostre a senha e copie à mão.'}
      </p>
      <p className="text-xs text-muted-foreground">
        É a mesma para todos os agentes deste ambiente e só serve para registrar um agente novo. Se ela vazar,
        peça a troca ao suporte da Verax; os agentes já registrados continuam funcionando.
      </p>
    </div>
  );
}

/** Script pronto, com o botão de copiar: a tela pode mostrar a senha mascarada, mas a cópia é o script exato. */
function ScriptBlock({ display, copy, label }: { display: string; copy: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyScript = () => {
    const writing = navigator.clipboard?.writeText(copy);
    if (writing === undefined) {
      setState('failed');
      return;
    }
    void writing.then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };
  return (
    <div className="space-y-1">
      {/* Rola por dentro (o script é comprido): a região tem nome e recebe o foco do teclado. */}
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="max-h-96 overflow-auto rounded bg-foreground/5"
      >
        <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">
          <code>{display}</code>
        </pre>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={copyScript}
        aria-label={`Copiar: ${label}`}
      >
        <Copy aria-hidden />
        {state === 'copied' ? 'Copiado' : 'Copiar o script'}
      </Button>
      <p aria-live="polite" className={state === 'failed' ? 'text-xs text-critical-text' : 'sr-only'}>
        {state === 'copied' && 'Script copiado.'}
        {state === 'failed' && 'Não foi possível copiar. Selecione o script e copie à mão.'}
      </p>
    </div>
  );
}

function AgentList() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const agents = useAgents({ page, pageSize: PAGE_SIZE }, true);
  const syncedAt = agents.data?.syncedAt ?? null;
  const stale = syncedAt !== null && agentListIsStale(syncedAt);

  const columns: Column<Agent>[] = [
    {
      key: 'nome',
      header: 'Nome',
      cell: (row) => (
        <>
          <span className="block font-medium">{row.name}</span>
          <span className="block text-xs text-muted-foreground">Agente {row.agentId}</span>
        </>
      ),
    },
    {
      key: 'sistema',
      header: 'Sistema',
      cell: (row) =>
        row.osName ? (
          `${row.osName}${row.osVersion ? ` ${row.osVersion}` : ''}`
        ) : (
          <span className="text-muted-foreground">Ainda não informado</span>
        ),
    },
    {
      key: 'ip',
      header: 'IP',
      cell: (row) => <span className="font-mono text-xs">{row.ip === 'any' || !row.ip ? '—' : row.ip}</span>,
    },
    {
      key: 'versao',
      header: 'Versão',
      cell: (row) => row.version?.replace(/^Wazuh /, '') ?? '—',
    },
    {
      key: 'situacao',
      header: 'Situação',
      cell: (row) => {
        const status = AGENT_STATUS_LABELS[row.status];
        return (
          <span className={cn('inline-block rounded-full border px-2 py-0.5 text-xs', status.className)}>
            {status.label}
          </span>
        );
      },
    },
    {
      key: 'sinal',
      header: 'Último sinal',
      className: 'whitespace-nowrap',
      cell: (row) =>
        row.lastKeepAliveAt ? (
          <time dateTime={row.lastKeepAliveAt} title={formatTimestamp(row.lastKeepAliveAt)}>
            {formatRelative(row.lastKeepAliveAt)}
          </time>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <section aria-labelledby="lista-agentes" className="space-y-3">
      <h2 id="lista-agentes" className="text-lg font-semibold">
        Agentes registrados
      </h2>
      {syncedAt !== null && (
        <p
          className={cn(
            'text-sm',
            stale ? 'rounded-md border border-high/60 bg-high/10 p-3' : 'text-muted-foreground',
          )}
        >
          {stale
            ? `A lista não é atualizada desde ${formatTimestamp(syncedAt)}: o estado dos agentes pode estar diferente. Se continuar assim, fale com o suporte da Verax.`
            : `Lista atualizada ${formatRelative(syncedAt)}.`}
        </p>
      )}
      <DataTable
        caption="Agentes registrados"
        columns={columns}
        rows={agents.data?.items}
        rowKey={(row) => row.id}
        page={page}
        pageSize={PAGE_SIZE}
        total={agents.data?.total ?? 0}
        onPageChange={(next) =>
          setParams((previous) => {
            const params = new URLSearchParams(previous);
            params.set('pagina', String(next));
            return params;
          })
        }
        loading={agents.isPending}
        error={agents.error}
        onRetry={() => void agents.refetch()}
        emptyTitle="Nenhum agente registrado ainda"
        emptyDescription="Instale o agente numa instância com o script acima: ela aparece aqui em até um minuto."
      />
    </section>
  );
}
