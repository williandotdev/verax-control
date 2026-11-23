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
   * Passo que mostra um exemplo: o primeiro incidente ou alerta do cliente da sessão, buscado na hora (o admin da
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
 * O percurso: a tela Detecções, a postura e os ativos, a administração e o convite final. Cada texto descreve só o que a
 * tela mostra; os passos com `permission` saem do tour de quem não vê aquela tela.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'deteccoes-situacao',
    path: '/',
    target: [tour('deteccoes-situacao')],
    title: 'Detecções: está tudo bem?',
    body: 'A tela de entrada. No topo, a situação agora: o radar das últimas 24 horas em destaque e, numa linha, o que pede atenção (incidente crítico ou alto aberto, postura baixa ou coleta parada). Recolha o resumo para a lista subir; a escolha fica salva.',
  },
  {
    id: 'deteccoes-decisoes',
    path: '/',
    target: [tour('deteccoes-decisoes'), tour('deteccoes-situacao')],
    title: 'O que decidir agora',
    body: 'Cada linha é uma decisão esperando alguém: incidentes sem responsável, alertas altos ou críticos para validar e, para a equipe da Verax, alertas de contas não cadastradas. O botão filtra a lista. Ao lado, a saúde da coleta abre o detalhe de cada fonte.',
  },
  {
    id: 'deteccoes-radar',
    path: '/',
    target: [tour('deteccoes-radar'), tour('deteccoes-situacao')],
    title: 'Radar das últimas 24 horas',
    body: 'Cada ponto é uma detecção: o ângulo é a origem (AWS, GCP, Cloudflare ou agentes), a distância do centro é a idade e a forma é a severidade. Passe o mouse, use as setas do teclado ou abra a tabela; Enter abre o alerta.',
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
    id: 'deteccoes-lista',
    path: '/',
    target: [inMain('deteccoes-lista'), inMain('filtros')],
    permission: 'incidents:read',
    title: 'Alerta, validação, incidente',
    body: 'Cada evento suspeito vira um alerta para validar: pode ser falso positivo. Quando a ameaça é real, quem opera promove o alerta a incidente, com nota de risco e responsável. Troque para "Incidentes" para ver só os confirmados.',
  },
  {
    id: 'deteccoes-filtros',
    path: '/',
    target: [inMain('filtros')],
    permission: 'findings:read',
    title: 'Um filtro para tudo',
    body: 'Busque por usuário, IP ou recurso e filtre por período (inclusive datas escolhidas), severidade, status, fonte, conta e tática ou técnica do MITRE. O endereço guarda os filtros, e "Exportar CSV" leva a lista filtrada.',
  },
  {
    id: 'incidente',
    path: '/',
    example: 'incident',
    target: [tour('incidente-resumo')],
    permission: 'incidents:read',
    title: 'Detalhe do incidente',
    body: 'O detalhe abre ao lado da lista: a severidade, o status e a nota de risco, o resumo em português com o primeiro passo, o responsável, os alertas confirmados (com "Remover do incidente") e os ativos envolvidos.',
  },
  {
    id: 'alerta-validacao',
    path: '/',
    example: 'finding',
    target: [tour('alerta-validacao'), tour('achado-triagem')],
    permission: 'findings:triage',
    title: 'Validar o alerta',
    body: 'No detalhe do alerta, você decide: ameaça real vira incidente ("Promover a incidente", com os relacionados já marcados, ou "Anexar a um incidente aberto"); falso positivo é marcado como legítimo, e o painel oferece uma exceção para alertas iguais.',
  },
  {
    id: 'deteccoes-analise',
    path: '/?analise=mitre',
    target: [inMain('deteccoes-analise')],
    permission: 'reports:read',
    title: 'Análise: MITRE e cobertura',
    body: 'As 14 táticas do MITRE ATT&CK, com alertas e incidentes no período, e a cobertura de cada conta monitorada. Clique numa tática para filtrar a lista; as tabelas exportam em CSV.',
  },
  {
    id: 'postura',
    path: '/postura',
    target: [inMain('postura-contas')],
    permission: 'posture:read',
    title: 'Postura cloud',
    body: 'A configuração de cada conta AWS é conferida todo dia pelo papel somente leitura. Cada conta mostra a nota, a evolução e as checagens reprovadas; mais abaixo, o que corrigir, do mais grave ao menos grave, com o porquê e o passo a passo.',
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
    body: 'Contas AWS, projetos da GCP e contas do Cloudflare monitorados. Na AWS, o botão Conectar com AWS cria um papel de leitura sem chave, e você autoriza as fontes de log que o Verax encontra; na GCP, o comando do sink; no Cloudflare, o token só de leitura, cifrado no cofre do nó. O Verax só lê.',
  },
  {
    id: 'protecao-excecoes',
    path: '/cadastros/protecao',
    target: [inMain('tabela')],
    permission: 'protected_resources:read',
    title: 'Lista de proteção e exceções',
    body: 'Aqui ficam as contas, identidades e recursos críticos do cliente: um incidente que envolva um deles ganha 15 pontos na nota de risco. Em Exceções, no mesmo menu, ficam os comportamentos esperados, criados ali ou na validação de um alerta.',
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
