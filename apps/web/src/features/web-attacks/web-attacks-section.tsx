import {
  type AwsOnboarding,
  type AwsSource,
  type CloudAccount,
  type WebLogSource,
  type WebTrustedSource,
} from '@verax/shared';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Section, Tag } from '@/features/admin/aws-ui';
import { awsSourceName } from '@/features/admin/aws-onboarding-labels';
import { compareAwsSources, isAuthorizedSource } from '@/features/admin/aws-sources';
import { cn } from '@/lib/cn';
import { webAttacksAnchor } from './anchors';
import { ModePanel, MultiplierForm } from './mode-panel';
import { ReadingHealth } from './reading-health';
import { RoutesPanel } from './routes-panel';
import { TrustedPanel } from './trusted-panel';
import { useTrustedSources, useWebHealth, useWebLogSources } from './web-logs-api';
import { DETECTION_LIMITS, WEB_DATA_TEXT, WEB_MODE_LABELS } from './web-logs-labels';

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t pt-3">
      <h5 className="text-sm font-semibold">{title}</h5>
      {children}
    </div>
  );
}

/** Um balanceador autorizado: o modo, a leitura, os limites e as rotas. A leitura só é pedida com o quadro aberto. */
function BalancerPanel({
  source,
  web,
  trusted,
  canWrite,
  open,
  onOpenChange,
}: {
  source: AwsSource;
  web: WebLogSource;
  trusted: readonly WebTrustedSource[];
  canWrite: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const name = awsSourceName(source);
  const health = useWebHealth(source.id, open);
  const { settings } = web;
  return (
    <div
      id={webAttacksAnchor(source.id)}
      className="scroll-mt-4 rounded-md border target:outline-2 target:outline-offset-2 target:outline-ring"
    >
      <h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${webAttacksAnchor(source.id)}-quadro`}
          onClick={() => onOpenChange(!open)}
          className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm font-medium"
        >
          <ChevronRight
            aria-hidden
            className={cn('mt-0.5 size-4 shrink-0 transition-transform', open && 'rotate-90')}
          />
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 font-mono text-xs wrap-anywhere">{name}</span>
            <span className="text-muted-foreground">{source.region}</span>
            {settings !== null && <Tag>{WEB_MODE_LABELS[settings.mode]}</Tag>}
            {web.internetFacing === true && <Tag>Aberto à internet</Tag>}
          </span>
        </button>
      </h4>
      {open && (
        <div id={`${webAttacksAnchor(source.id)}-quadro`} className="space-y-3 border-t p-3">
          {settings === null ? (
            <p className="text-sm text-muted-foreground">
              A configuração deste balanceador ainda não foi criada. Atualize a tela em instantes.
            </p>
          ) : (
            <ModePanel
              sourceId={source.id}
              name={name}
              settings={settings}
              health={health.data ?? null}
              canWrite={canWrite}
            />
          )}
          <Block title="Leitura do log">
            <ReadingHealth source={source} health={health.data ?? null} trusted={trusted} />
            {health.error && health.data === undefined ? (
              <ErrorState error={health.error} onRetry={() => void health.refetch()} />
            ) : null}
            {health.isLoading && <LoadingState rows={2} label="Carregando as contagens" />}
          </Block>
          {settings !== null && (
            <Block title="Limites das regras">
              <MultiplierForm sourceId={source.id} name={name} settings={settings} canWrite={canWrite} />
            </Block>
          )}
          <Block title="Rotas declaradas">
            <RoutesPanel sourceId={source.id} name={name} canWrite={canWrite} />
          </Block>
        </div>
      )}
    </div>
  );
}

/**
 * "Ataques web": a detecção pelos logs de acesso dos balanceadores autorizados desta conta. O modo de cada um (observar ou
 * alertar), o que a observação contou, a leitura, os limites e as rotas; as fontes confiáveis do cliente; e o que a detecção não
 * vê. Num nó em que ela não existe (desligada, de antes dela, ou na célula), a seção não aparece, e nada é pedido à API.
 */
export function WebAttacksSection({
  account,
  onboarding,
  canWrite,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
}) {
  const authorized = onboarding.sources
    .filter((source) => source.kind === 'elb_logs' && source.collectable && isAuthorizedSource(source))
    .sort(compareAwsSources);
  const enabled = authorized.length > 0;
  const web = useWebLogSources(account.id, enabled);
  const trusted = useTrustedSources(enabled && web.data != null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const single = authorized.length === 1 ? (authorized[0]?.id ?? null) : null;
  const [touched, setTouched] = useState(false);
  const editable = canWrite && account.status === 'active';

  // A linha da tabela aponta para cá (`#ataques-web-…`): o quadro apontado abre.
  useEffect(() => {
    const follow = () => {
      const target = authorizedIdOf(window.location.hash);
      if (target !== null) setOpened((current) => new Set(current).add(target));
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  if (!enabled || web.data === null) return null;
  const byId = new Map((web.data ?? []).map((item) => [item.id, item]));
  const isOpen = (id: string) => opened.has(id) || (!touched && id === single);
  const setOpen = (id: string, value: boolean) => {
    if (value === isOpen(id)) return;
    setTouched(true);
    setOpened((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const available = authorized.flatMap((source) => {
    const item = byId.get(source.id);
    return item === undefined ? [] : [{ source, web: item }];
  });

  return (
    <Section id="aws-ataques-web" title="Ataques web">
      <p className="text-sm text-muted-foreground">
        O que o Verax detecta nos logs de acesso dos balanceadores autorizados: varredura, força bruta e
        acesso depois de muitas falhas. {WEB_DATA_TEXT}
      </p>
      {web.data === undefined ? (
        web.error ? (
          <ErrorState error={web.error} onRetry={() => void web.refetch()} />
        ) : (
          <LoadingState rows={2} label="Carregando os balanceadores" />
        )
      ) : (
        <>
          <div className="space-y-2">
            {available.map(({ source, web: item }) => (
              <BalancerPanel
                key={source.id}
                source={source}
                web={item}
                trusted={trusted.data?.items ?? []}
                canWrite={editable}
                open={isOpen(source.id)}
                onOpenChange={(value) => setOpen(source.id, value)}
              />
            ))}
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Fontes confiáveis</h4>
            <TrustedPanel balancers={available.map(({ web: item }) => item)} canWrite={editable} />
          </div>
          <details className="rounded-md border text-sm">
            <summary className="cursor-pointer px-3 py-2 font-medium">O que esta detecção não vê</summary>
            <ul className="space-y-2 border-t p-3">
              {DETECTION_LIMITS.map(({ title, text }) => (
                <li key={title}>
                  <span className="font-medium">{title}.</span>{' '}
                  <span className="text-muted-foreground">{text}</span>
                </li>
              ))}
            </ul>
          </details>
          {!canWrite && (
            <p className="text-sm text-muted-foreground">
              Quem administra as contas muda o modo, os limites, as rotas e as fontes confiáveis.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

const ANCHOR_PREFIX = `#${webAttacksAnchor('')}`;

/** O balanceador que o endereço aponta; null se não aponta nenhum. */
function authorizedIdOf(hash: string): string | null {
  return hash.startsWith(ANCHOR_PREFIX) ? hash.slice(ANCHOR_PREFIX.length) : null;
}
