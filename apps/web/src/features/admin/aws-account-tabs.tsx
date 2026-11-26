import { Tabs } from 'radix-ui';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { type AwsAccountTab, isAwsAccountTab } from '@/features/admin/aws-account-view';

/**
 * As abas do detalhe da conta AWS já conectada (E-04 da auditoria de UX). O conteúdo de hoje só muda de lugar: cada aba
 * guarda seções inteiras, e todas ficam montadas (as escondidas com `hidden`), para que nenhum estado se perca ao trocar
 * de aba e para que todo link interno (`#aws-conferencias`, a linha de uma fonte, um balanceador, `#aws-buckets`) ache o
 * alvo: ao seguir um desses links, a aba que guarda o alvo abre e a tela rola até ele.
 *
 * A aba fica no endereço (`aba=`), para um link apontar direto para ela; a "Visão geral" é a de sem `aba`.
 */
export interface AwsAccountTabItem {
  value: AwsAccountTab;
  label: string;
  /** Um número entre parênteses depois do nome ("Fontes lidas (17)"); sem ele, só o nome. */
  count?: number;
  content: ReactNode;
}

/** O `id` do painel de uma aba: os links internos acham a aba pelo ancestral com este atributo. */
const PANEL_ATTRIBUTE = 'data-aws-tab';

export function AwsAccountTabs({
  tab,
  onTabChange,
  items,
}: {
  tab: AwsAccountTab;
  onTabChange: (tab: AwsAccountTab) => void;
  items: readonly AwsAccountTabItem[];
}) {
  const root = useRef<HTMLDivElement>(null);
  // O alvo de um link interno que estava numa aba escondida: depois de a aba abrir, a tela rola até ele.
  const pending = useRef<string | null>(null);

  /** Abre a aba que guarda o alvo (um `id`); devolve se achou o alvo dentro das abas. */
  const reveal = useCallback(
    (id: string): boolean => {
      const target = id === '' ? null : root.current?.querySelector(`[id="${CSS.escape(id)}"]`);
      const panel = target?.closest(`[${PANEL_ATTRIBUTE}]`);
      const owner = panel?.getAttribute(PANEL_ATTRIBUTE) ?? null;
      if (!target || !isAwsAccountTab(owner)) return false;
      if (owner === tab) {
        target.scrollIntoView({ block: 'start' });
        return true;
      }
      pending.current = id;
      onTabChange(owner);
      return true;
    },
    [tab, onTabChange],
  );

  // O link seguido pelo endereço (`#alvo`): ao abrir a conta com ele e a cada troca do `#`.
  useEffect(() => {
    const follow = () => reveal(decodeURIComponent(window.location.hash.slice(1)));
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
    // Só ao montar: o `reveal` novo de cada aba não deve seguir de novo o mesmo `#`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // As abas aparecem no meio do uso (a primeira autorização de fontes termina o passo a passo): se o foco ficou sem
  // lugar (o botão confirmado saiu da tela), ele vai para a aba aberta, e não para o começo da página.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body || active.getAttribute('role') === 'dialog') {
      root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }
  }, []);

  useEffect(() => {
    const id = pending.current;
    if (id === null) return;
    pending.current = null;
    root.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
  }, [tab]);

  return (
    <div
      ref={root}
      // O link interno clicado de novo (o mesmo `#`) não dispara `hashchange`: o clique também abre a aba do alvo.
      onClickCapture={(event) => {
        const anchor = (event.target as Element).closest('a[href^="#"]');
        const href = anchor?.getAttribute('href');
        if (href && href.length > 1 && reveal(decodeURIComponent(href.slice(1)))) {
          if (window.location.hash === href) event.preventDefault();
        }
      }}
    >
      <Tabs.Root value={tab} onValueChange={(value) => isAwsAccountTab(value) && onTabChange(value)}>
        <Tabs.List aria-label="Partes do detalhe da conta" className="flex flex-wrap gap-x-1 border-b">
          {items.map((item) => (
            <Tabs.Trigger
              key={item.value}
              value={item.value}
              className="-mb-px inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground"
            >
              {item.count === undefined ? item.label : `${item.label} (${item.count})`}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {items.map((item) => (
          <Tabs.Content
            key={item.value}
            value={item.value}
            forceMount
            // Montada sempre, escondida de todos (inclusive do leitor de tela) quando não é a aba aberta.
            hidden={item.value !== tab}
            {...{ [PANEL_ATTRIBUTE]: item.value }}
            className="space-y-5 pt-4 focus-visible:outline-2 focus-visible:outline-ring"
          >
            {item.content}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  );
}
