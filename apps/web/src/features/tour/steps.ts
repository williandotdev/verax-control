import type { Permission } from '@verax/shared';

/** Um passo do tour guiado da demonstração. */
export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Tela do passo (caminho e busca). Sem ela, o passo fica na tela em que o tour está. */
  path?: string;
  /**
   * Seletores do elemento destacado, em ordem de preferência. Um alvo que existe mas está escondido (menu recolhido
   * no celular) passa a vez ao seguinte; sem alvo visível, o cartão aparece no centro, sem destaque.
   */
  target?: readonly string[];
  /** Só entra no tour de quem tem a permissão: para os outros, a tela ou o elemento nem existem. */
  permission?: Permission;
  /** Link de saída, aberto em outra aba. */
  link?: { href: string; label: string };
  /**
   * Passo que mostra um exemplo: o primeiro incidente ou achado do cliente da sessão, buscado na hora (o admin da
   * Verax pode ter trocado de cliente). Sem nenhum, o passo fica na lista (`path`).
   */
  example?: 'incident' | 'finding';
}

/** Endereço do site da Verax, para o convite do fim do tour. */
export const VERAX_SITE = 'https://veraxsistemas.com.br';

const tour = (name: string) => `[data-tour="${name}"]`;
/** Os alvos de tela ficam dentro do conteúdo da página (fora do menu e do cabeçalho). */
const inMain = (name: string) => `main ${tour(name)}`;

/**
 * O percurso: a Torre, a operação do dia a dia, a administração e o convite final. Cada texto descreve só o que a
 * tela mostra; os passos com `permission` saem do tour de quem não vê aquela tela.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'torre-semaforo',
    path: '/',
    target: [tour('torre-semaforo')],
    title: 'Torre: está tudo bem?',
    body: 'A Torre é a tela de entrada. O semáforo fica vermelho com incidente crítico aberto e amarelo com incidente alto aberto ou nota de postura abaixo do limite, sempre com o motivo. Mais abaixo ficam os incidentes abertos, a nota de postura e a cobertura das contas.',
  },
  {
    id: 'torre-decisoes',
    path: '/',
    target: [tour('torre-decisoes')],
    title: 'O que decidir agora',
    body: 'Cada cartão é uma decisão esperando alguém: incidentes sem responsável, achados altos ou críticos sem triagem e, para a equipe da Verax, alertas de contas não cadastradas. O botão leva à lista já filtrada.',
  },
  {
    id: 'torre-mitre',
    path: '/',
    target: [tour('torre-mitre')],
    title: 'MITRE ATT&CK',
    body: 'As 14 táticas da cadeia de ataque, na ordem, com quantos achados e incidentes cada uma teve no período. Clique numa tática para abrir o relatório completo.',
  },
  {
    id: 'seletor-cliente',
    path: '/',
    target: [tour('seletor-cliente')],
    permission: 'session:switch_tenant',
    title: 'Um cliente por vez',
    body: 'A equipe da Verax escolhe aqui qual cliente está vendo. A troca vale só para esta sessão, fica registrada na auditoria e tira da tela os dados do cliente anterior. Os clientes são cadastrados em Administração, no menu, cada um já com o primeiro administrador dele.',
  },
  {
    id: 'incidentes',
    path: '/incidentes',
    target: [inMain('tabela')],
    permission: 'incidents:read',
    title: 'Incidentes',
    body: 'Achados com o mesmo usuário, chave de acesso, IP ou recurso viram um incidente. A lista vem pela nota de risco, a maior primeiro, com filtros por status, severidade e responsável.',
  },
  {
    id: 'incidente',
    path: '/incidentes',
    example: 'incident',
    target: [inMain('incidente-resumo')],
    permission: 'incidents:read',
    title: 'Detalhe do incidente',
    body: 'No topo, a severidade, o status e a nota de risco, de 0 a 100. O resumo conta em português o que aconteceu e sugere o primeiro passo; abaixo, a linha do tempo mostra cada achado, e ao lado ficam o responsável e os ativos envolvidos.',
  },
  {
    id: 'achados',
    path: '/achados',
    target: [inMain('filtros')],
    permission: 'findings:read',
    title: 'Achados',
    body: 'Cada alerta de segurança das contas do cliente vira um achado. Filtre por severidade, status, conta e período, e abra um achado para ver o evento completo.',
  },
  {
    id: 'achado-triagem',
    path: '/achados',
    example: 'finding',
    target: [tour('achado-triagem')],
    permission: 'findings:triage',
    title: 'Triagem e exceção',
    body: 'No detalhe do achado, você coloca em análise, marca como legítimo ou dá como resolvido, com um comentário. Ao marcar como legítimo, o painel oferece criar uma exceção: alertas iguais da mesma regra passam a entrar como esperados.',
  },
  {
    id: 'postura',
    path: '/postura',
    target: [inMain('postura-contas')],
    permission: 'posture:read',
    title: 'Postura cloud',
    body: 'O Prowler confere a configuração de cada conta AWS todo dia. Cada conta mostra a nota, a evolução e as checagens reprovadas; mais abaixo, o que corrigir, do mais grave ao menos grave, com o porquê e o passo a passo.',
  },
  {
    id: 'ativos',
    path: '/ativos',
    target: [inMain('ativos-abas')],
    permission: 'assets:read',
    title: 'Ativos e identidades',
    body: 'O inventário de cada conta AWS, lido por um papel somente leitura: usuários IAM, chaves de acesso, instâncias EC2, buckets S3 e security groups, cada item com o risco e o motivo.',
  },
  {
    id: 'relatorios',
    path: '/relatorios',
    target: [inMain('relatorios-abas')],
    permission: 'reports:read',
    title: 'Relatórios',
    body: 'Para quem quer analisar a fundo: resumo do período, MITRE ATT&CK, detecções, entidades, incidentes, cobertura das fontes e exceções. Escolha 7, 30 ou 90 dias e exporte as tabelas em CSV.',
  },
  {
    id: 'alertas-sem-dono',
    path: '/alertas-sem-dono',
    target: [inMain('sem-dono-contas')],
    permission: 'unowned_alerts:read',
    title: 'Alertas sem dono',
    body: 'Só a equipe da Verax vê esta fila: alertas que não pertencem a nenhum cliente. As contas que mais aparecem mostram o que falta cadastrar, com atalho para o cadastro da conta.',
  },
  {
    id: 'auditoria',
    path: '/auditoria',
    target: [inMain('tabela')],
    permission: 'audit:read',
    title: 'Auditoria',
    body: 'Tudo o que foi feito no painel do cliente: quem fez, o quê, quando e de onde. Os registros não podem ser alterados nem apagados.',
  },
  {
    id: 'usuarios',
    path: '/cadastros/usuarios',
    target: [inMain('tabela')],
    permission: 'users:read',
    title: 'Usuários',
    body: 'Toda conta nasce com uma senha temporária, mostrada uma única vez a quem criou. No primeiro acesso, a pessoa troca a senha e cadastra o MFA, obrigatório para entrar no painel.',
  },
  {
    id: 'contas-cloud',
    path: '/cadastros/contas',
    target: [inMain('tabela')],
    permission: 'cloud_accounts:read',
    title: 'Contas cloud',
    body: 'Contas AWS, projetos da GCP e contas do Cloudflare monitorados. Cada provedor tem o passo a passo: o template do conector na AWS, o comando do sink na GCP e, no Cloudflare, o token só de leitura, colado aqui e cifrado no cofre do nó. O Verax só lê.',
  },
  {
    id: 'protecao-excecoes',
    path: '/cadastros/protecao',
    target: [inMain('tabela')],
    permission: 'protected_resources:read',
    title: 'Lista de proteção e exceções',
    body: 'Aqui ficam as contas, identidades e recursos críticos do cliente: um incidente que envolva um deles ganha 15 pontos na nota de risco. Em Exceções, no mesmo menu, ficam os comportamentos esperados, criados ali ou na triagem de um achado.',
  },
  {
    id: 'tema',
    target: [tour('tema')],
    title: 'Tema claro ou escuro',
    body: 'Escolha aqui o tema claro, o escuro ou o mesmo do sistema. A escolha fica salva neste navegador.',
  },
  {
    id: 'fim',
    title: 'Gostou? Contrate pelo site',
    body: 'Você conheceu o Verax Control de ponta a ponta. Para monitorar as contas da sua empresa, fale com a Verax pelo site.',
    link: { href: VERAX_SITE, label: 'veraxsistemas.com.br' },
  },
];

/** O percurso de quem tem estas permissões. */
export function tourStepsFor(
  permissions: readonly Permission[],
  steps: readonly TourStep[] = TOUR_STEPS,
): TourStep[] {
  return steps.filter((step) => !step.permission || permissions.includes(step.permission));
}
