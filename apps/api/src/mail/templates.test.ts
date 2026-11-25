import { describe, expect, it } from 'vitest';
import {
  type DigestItem,
  type DigestMail,
  digestMail,
  escalationConfirmationMail,
  type EscalationNotice,
  escalationNoticeMail,
  type NoticeMail,
  noticeMail,
} from './templates.js';

const origin = 'https://cliente.control.exemplo.com.br';
const incidentLink = `${origin}/?incidente=018f2c1e-0000-7000-8000-0000000000c1`;

const notices: NoticeMail[] = [
  { kind: 'incident_opened', severity: 'high', link: incidentLink },
  { kind: 'incident_opened', severity: 'critical', link: incidentLink },
  { kind: 'incident_escalated', severity: 'high', link: incidentLink },
  { kind: 'incident_escalated', severity: 'critical', link: incidentLink },
  { kind: 'critical_finding', link: `${origin}/?alerta=018f2c1e-0000-7000-8000-0000000000f1` },
  { kind: 'aws_ingestion_stalled', link: `${origin}/cadastros/contas` },
  {
    kind: 'plan_usage',
    percent: 80,
    month: new Date('2026-11-01T00:00:00.000Z'),
    link: `${origin}/cadastros/plano`,
  },
  {
    kind: 'plan_usage',
    percent: 100,
    month: new Date('2026-11-01T00:00:00.000Z'),
    link: `${origin}/cadastros/plano`,
  },
  { kind: 'high_finding', link: `${origin}/?alerta=018f2c1e-0000-7000-8000-0000000000f2` },
  { kind: 'incident_opened', severity: 'medium', link: incidentLink },
];

describe('e-mail dos avisos (PR-16)', () => {
  it('assunto fixo por tipo e severidade, numa linha só', () => {
    const subjects = notices.map((notice) => noticeMail('pessoa@cliente.example', 'Ana', notice).subject);
    expect(subjects).toEqual([
      'Incidente de severidade alta confirmado no Verax Control',
      'Incidente de severidade crítica confirmado no Verax Control',
      'Incidente subiu para severidade alta no Verax Control',
      'Incidente subiu para severidade crítica no Verax Control',
      'Alerta de severidade crítica no Verax Control',
      'Coleta da AWS parada no Verax Control',
      '80% do volume mensal do plano no Verax Control',
      'Volume mensal do plano atingido no Verax Control',
      'Alerta de severidade alta no Verax Control',
      'Incidente de severidade média confirmado no Verax Control',
    ]);
    // eslint-disable-next-line no-control-regex -- confere que nenhum caractere de controle chega ao assunto
    for (const subject of subjects) expect(subject).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('o assunto não muda com o nome de quem recebe, nem com quebra de linha nele', () => {
    const notice = notices[0] as NoticeMail;
    const message = noticeMail('pessoa@cliente.example', 'Ana\r\nBcc: outra@exemplo.com', notice);
    expect(message.subject).toBe('Incidente de severidade alta confirmado no Verax Control');
    expect(message.to).toBe('pessoa@cliente.example');
  });

  it('HTML escapado: o nome de quem recebe não vira marcação, e o link vai no href escapado', () => {
    const message = noticeMail('pessoa@cliente.example', '<script>alert("x")</script> & \'Bia\'', {
      kind: 'critical_finding',
      link: `${origin}/?alerta=1&x="><img src=x>`,
    });
    expect(message.html).toContain(
      '<p>Olá, &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Bia&#39;.</p>',
    );
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain(
      `<a href="${origin}/?alerta=1&amp;x=&quot;&gt;&lt;img src=x&gt;">Ver o alerta</a>`,
    );
    // O texto puro leva o nome e o link como vieram (não é HTML).
    expect(message.text).toContain('Olá, <script>');
  });

  it('o corpo é só o texto fixo do tipo e o link: nada do achado, do incidente ou da conta', () => {
    const message = noticeMail('pessoa@cliente.example', 'Ana', notices[1] as NoticeMail);
    expect(message.text).toBe(
      [
        'Olá, Ana.',
        'Alertas foram validados e confirmados como um incidente de severidade crítica.',
        'Por segurança, os detalhes (contas, recursos, IPs e identidades) aparecem só no painel, depois do login com MFA.',
        `Ver o incidente: ${incidentLink}`,
        'Você recebe este aviso por ter acesso a este cliente no Verax Control.',
        'Para não receber mais os avisos de alertas e incidentes por e-mail, desligue a opção em Minha conta, no painel.',
        'Verax Control',
      ].join('\n\n'),
    );
    expect(message.html).toContain(`<a href="${incidentLink}">Ver o incidente</a>`);
  });

  it("como deixar de receber só nos avisos que a preferência controla (PR-17')", () => {
    const hint = 'desligue a opção em Minha conta';
    const texts = notices.map((notice) => noticeMail('pessoa@cliente.example', 'Ana', notice).text);
    // Incidente aberto (alto e crítico), incidente que subiu (alto e crítico) e achado crítico; não o plano nem a coleta.
    expect(texts.map((text) => text.includes(hint))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('volume do plano: o mês por extenso e a coleta que continua', () => {
    const eighty = noticeMail('admin@cliente.example', 'Ana', notices[6] as NoticeMail);
    expect(eighty.text).toContain(
      'O volume de logs lido em novembro de 2026 chegou a 80% do limite mensal do plano.',
    );
    const hundred = noticeMail('admin@cliente.example', 'Ana', notices[7] as NoticeMail);
    expect(hundred.text).toContain('chegou ao limite mensal do plano');
    expect(hundred.text).toContain('A coleta, os alertas e os incidentes continuam normalmente.');
  });
});

describe("resumo por hora e de retomada (PR-17')", () => {
  /** 14:00 em Brasília (17:00 UTC) de 05/11/2026. */
  const hourStart = new Date('2026-11-05T17:00:00.000Z');
  const item = (notice: NoticeMail, minute: number): DigestItem => ({
    notice,
    at: new Date(hourStart.getTime() + minute * 60_000),
  });
  const digest = (overrides: Partial<DigestMail> = {}): DigestMail => ({
    catchUp: false,
    hourStart,
    items: [item(notices[1] as NoticeMail, 7), item(notices[4] as NoticeMail, 32)],
    total: 2,
    panelLink: `${origin}/`,
    ...overrides,
  });

  it('assunto fixo: o resumo da hora e o de retomada, numa linha só', () => {
    expect(digestMail('pessoa@cliente.example', 'Ana', digest()).subject).toBe(
      'Resumo dos avisos da hora no Verax Control',
    );
    const catchUp = digestMail(
      'pessoa@cliente.example',
      'Ana\r\nBcc: x@exemplo.com',
      digest({ catchUp: true }),
    );
    expect(catchUp.subject).toBe('Retomada dos avisos atrasados no Verax Control');
    expect(catchUp.to).toBe('pessoa@cliente.example');
  });

  it('a hora no horário de Brasília, cada item com a hora e o link, e nada do achado', () => {
    const message = digestMail('pessoa@cliente.example', 'Ana', digest());
    expect(message.text).toBe(
      [
        'Olá, Ana.',
        'Você recebeu 5 avisos por e-mail das 14h às 15h de 05/11/2026 (horário de Brasília). Para não lotar a sua caixa, os avisos seguintes dessa hora vieram reunidos aqui: 2 avisos no total.',
        [
          `- 05/11/2026, 14:07 · Incidente de severidade crítica confirmado: ${incidentLink}`,
          `- 05/11/2026, 14:32 · Alerta de severidade crítica: ${origin}/?alerta=018f2c1e-0000-7000-8000-0000000000f1`,
        ].join('\n'),
        'Por segurança, os detalhes (contas, recursos, IPs e identidades) aparecem só no painel, depois do login com MFA.',
        'Você recebe este resumo por ter acesso a este cliente no Verax Control.',
        'Para não receber mais os avisos de alertas e incidentes por e-mail, desligue a opção em Minha conta, no painel.',
        'Verax Control',
      ].join('\n\n'),
    );
    expect(message.html).toContain(
      `<li>05/11/2026, 14:07 · <a href="${incidentLink}">Incidente de severidade crítica confirmado</a></li>`,
    );
    expect(message.text).not.toContain('E mais');
  });

  it('passa da lista: "e mais N", com o link do painel', () => {
    // O total de verdade, escrito como aqui: 12.835.
    const large = digestMail('pessoa@cliente.example', 'Ana', digest({ total: 12_835 }));
    expect(large.text).toContain('12.835 avisos no total');
    expect(large.html).toContain('12.835 avisos no total');
    expect(large.text).toContain('E mais 12.833 avisos neste resumo.');
    const message = digestMail('pessoa@cliente.example', 'Ana', digest({ total: 13 }));
    expect(message.text).toContain('13 avisos no total');
    expect(message.text).toContain(`E mais 11 avisos neste resumo. Veja todos no painel: ${origin}/`);
    expect(message.html).toContain(
      `<p>E mais 11 avisos neste resumo. <a href="${origin}/">Ver no painel</a></p>`,
    );
    expect(digestMail('pessoa@cliente.example', 'Ana', digest({ total: 3 })).text).toContain(
      'E mais 1 aviso neste resumo.',
    );
  });

  it('retomada: diz que o envio atrasou mais de 24 h, sem a hora do resumo', () => {
    const message = digestMail('pessoa@cliente.example', 'Ana', digest({ catchUp: true, total: 40 }));
    expect(message.text).toContain(
      'O envio dos avisos por e-mail ficou atrasado por mais de 24 horas. Para não mandar um e-mail por aviso antigo, os avisos desta retomada vieram reunidos aqui: 40 avisos no total.',
    );
    expect(message.text).not.toContain('horário de Brasília');
  });

  it('HTML escapado: o nome de quem recebe e os links', () => {
    const message = digestMail('pessoa@cliente.example', "<img src=x onerror=alert(1)> & 'Bia'", {
      ...digest(),
      items: [item({ kind: 'critical_finding', link: `${origin}/?alerta=1&x="><script>` }, 1)],
      total: 12,
      panelLink: `${origin}/"><script>`,
    });
    expect(message.html).toContain('<p>Olá, &lt;img src=x onerror=alert(1)&gt; &amp; &#39;Bia&#39;.</p>');
    expect(message.html).not.toContain('<img');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain(`href="${origin}/?alerta=1&amp;x=&quot;&gt;&lt;script&gt;"`);
    expect(message.html).toContain(`href="${origin}/&quot;&gt;&lt;script&gt;"`);
  });

  it('sem aviso de incidente na lista (só o volume do plano): sem a linha da preferência', () => {
    const message = digestMail(
      'admin@cliente.example',
      'Ana',
      digest({ items: [item(notices[7] as NoticeMail, 3)], total: 1 }),
    );
    expect(message.text).toContain('1 aviso no total');
    expect(message.text).toContain('Volume mensal do plano atingido');
    expect(message.text).not.toContain('Minha conta');
  });

  it('perto da meia-noite de Brasília: das 23h às 0h', () => {
    const late = new Date('2026-11-06T02:00:00.000Z');
    expect(digestMail('pessoa@cliente.example', 'Ana', digest({ hourStart: late })).text).toContain(
      'das 23h às 0h de 05/11/2026 (horário de Brasília)',
    );
  });
});

describe('e-mails ao contato de escalonamento (D8)', () => {
  const confirmLink = `${origin}/escalonamento/confirmar#token=${'c'.repeat(43)}`;
  const unsubscribeLink = `${origin}/escalonamento/descadastrar#token=${'u'.repeat(43)}`;
  const critical: EscalationNotice[] = [
    { kind: 'incident_opened', severity: 'critical', link: incidentLink },
    { kind: 'incident_escalated', severity: 'critical', link: incidentLink },
    { kind: 'critical_finding', link: `${origin}/?alerta=018f2c1e-0000-7000-8000-0000000000f1` },
  ];

  it('o pedido de confirmação: assunto fixo, o que ele vai receber, os dois links e a validade', () => {
    const message = escalationConfirmationMail('contato@cliente.example', 'Ana', {
      confirmLink,
      unsubscribeLink,
      validHours: 72,
    });
    expect(message.to).toBe('contato@cliente.example');
    expect(message.subject).toBe('Confirme o contato de escalonamento no Verax Control');
    expect(message.text).toBe(
      [
        'Olá, Ana.',
        'Este endereço foi cadastrado como contato de escalonamento no Verax Control, o painel de segurança em nuvem da Verax. Se você confirmar, vai receber por e-mail só os avisos críticos (incidente de severidade crítica e alerta crítico), sem detalhes: eles ficam no painel, para quem tem acesso.',
        `Confirmar o endereço: ${confirmLink}`,
        'O link vale por 72 horas e só pode ser usado uma vez. Se você não reconhece este cadastro, ignore esta mensagem: sem a confirmação, nada mais é enviado a este endereço.',
        `Para não receber nem este pedido de novo, use o link: ${unsubscribeLink}`,
        'Verax Control',
      ].join('\n\n'),
    );
    expect(message.html).toContain(`<a href="${confirmLink}">Confirmar o endereço</a>`);
    expect(message.html).toContain(`<a href="${unsubscribeLink}">Não quero receber estes avisos</a>`);
  });

  it('o aviso crítico: o título e o texto fixos do tipo, o link do painel e o de descadastro, sem a dica de Minha conta', () => {
    const subjects = critical.map(
      (notice) => escalationNoticeMail('contato@cliente.example', 'Ana', notice, unsubscribeLink).subject,
    );
    expect(subjects).toEqual([
      'Incidente de severidade crítica confirmado no Verax Control',
      'Incidente subiu para severidade crítica no Verax Control',
      'Alerta de severidade crítica no Verax Control',
    ]);
    const message = escalationNoticeMail(
      'contato@cliente.example',
      'Ana',
      critical[0] as EscalationNotice,
      unsubscribeLink,
    );
    expect(message.text).toBe(
      [
        'Olá, Ana.',
        'Alertas foram validados e confirmados como um incidente de severidade crítica.',
        'Por segurança, os detalhes (contas, recursos, IPs e identidades) aparecem só no painel, depois do login com MFA.',
        `Ver o incidente no painel (com login): ${incidentLink}`,
        'Você recebe este e-mail por ser o contato de escalonamento cadastrado no Verax Control, que recebe só os avisos críticos.',
        `Para não receber mais, use o link: ${unsubscribeLink}`,
        'Verax Control',
      ].join('\n\n'),
    );
    expect(message.text).not.toContain('Minha conta');
    expect(message.html).toContain(`<a href="${unsubscribeLink}">Não quero mais receber estes avisos</a>`);
  });

  it('assunto numa linha só e HTML escapado no nome e nos links', () => {
    const name = "<img src=x onerror=alert(1)>\r\nBcc: outra@exemplo.com & 'Bia'";
    const hostile = `${origin}/escalonamento/descadastrar#token="><script>`;
    for (const message of [
      escalationConfirmationMail('contato@cliente.example', name, {
        confirmLink: hostile,
        unsubscribeLink: hostile,
        validHours: 72,
      }),
      escalationNoticeMail('contato@cliente.example', name, critical[2] as EscalationNotice, hostile),
    ]) {
      // eslint-disable-next-line no-control-regex -- confere que nenhum caractere de controle chega ao assunto
      expect(message.subject).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(message.subject).not.toContain('Bcc');
      expect(message.html).not.toContain('<img');
      expect(message.html).not.toContain('<script>');
      expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(message.html).toContain(
        `href="${origin}/escalonamento/descadastrar#token=&quot;&gt;&lt;script&gt;"`,
      );
    }
  });
});

describe('e-mails dos avisos por caso', () => {
  const caseLink = `${origin}/?caso=018f2c1e-0000-7000-8000-0000000000ca`;
  const queueLink = `${origin}/?visao=vulnerabilidades`;
  const opened: NoticeMail = {
    kind: 'case',
    severity: 'critical',
    growth: false,
    title: 'Atividade suspeita na conta da AWS',
    critical: 3,
    high: 12,
    link: caseLink,
  };
  const criticalCases: NoticeMail = {
    kind: 'cases_critical',
    cases: 2,
    critical: 5,
    items: [
      { title: 'Vulnerabilidade em pacote', critical: 4, high: 1, link: caseLink },
      { title: 'Controle de segurança reprovado', critical: 1, high: 0, link: `${caseLink}2` },
    ],
    link: queueLink,
  };
  const daily: NoticeMail = {
    kind: 'cases_daily',
    vulnerability: { cases: 1_250, critical: 40, high: 2_100 },
    posture: { cases: 1, critical: 0, high: 1 },
    items: [{ title: 'Vulnerabilidade em pacote', critical: 0, high: 7, link: caseLink }],
    link: queueLink,
  };
  const mail = (notice: NoticeMail) => noticeMail('pessoa@cliente.example', 'Ana', notice);

  it('assunto fixo por tipo e severidade: nem o título do caso', () => {
    expect(
      [
        opened,
        { ...opened, severity: 'high' as const },
        { ...opened, growth: true },
        criticalCases,
        daily,
      ].map((notice) => mail(notice).subject),
    ).toEqual([
      'Caso de severidade crítica no Verax Control',
      'Caso de severidade alta no Verax Control',
      'Caso de severidade crítica cresceu no Verax Control',
      'Casos críticos novos de vulnerabilidade ou postura no Verax Control',
      'Resumo diário de vulnerabilidades e postura no Verax Control',
    ]);
  });

  it('o caso: o título do dicionário, as contagens e o link, e nada do evento', () => {
    expect(mail(opened).text).toBe(
      [
        'Olá, Ana.',
        'O caso "Atividade suspeita na conta da AWS" tem 3 alertas críticos e 12 altos a validar: pode ser um falso positivo ou virar um incidente.',
        'Um caso reúne alertas parecidos: enquanto ele estiver pendente, os próximos alertas dele não geram um e-mail cada.',
        'Por segurança, os detalhes (contas, recursos, IPs e identidades) aparecem só no painel, depois do login com MFA.',
        `Ver o caso: ${caseLink}`,
        'Você recebe este aviso por ter acesso a este cliente no Verax Control.',
        'Para não receber mais os avisos de alertas e incidentes por e-mail, desligue a opção em Minha conta, no painel.',
        'Verax Control',
      ].join('\n\n'),
    );
    expect(mail(opened).html).toContain(`<a href="${caseLink}">Ver o caso</a>`);
  });

  it('as contagens: singular, plural e só o que há', () => {
    const counted = (critical: number, high: number) =>
      mail({ ...opened, critical, high })
        .text.split(' tem ')[1]
        ?.split(' a validar')[0];
    expect([
      counted(1, 0),
      counted(2, 0),
      counted(0, 1),
      counted(0, 2),
      counted(1, 1),
      counted(12_835, 2),
    ]).toEqual([
      '1 alerta crítico',
      '2 alertas críticos',
      '1 alerta alto',
      '2 alertas altos',
      '1 alerta crítico e 1 alto',
      '12.835 alertas críticos e 2 altos',
    ]);
  });

  it('o crescimento diz o que mudou', () => {
    const { text } = mail({ ...opened, growth: true });
    expect(text).toContain('O caso "Atividade suspeita na conta da AWS" mudou desde o último aviso');
    expect(text).toContain('A validar agora: 3 alertas críticos e 12 altos.');
    expect(text).not.toContain('tem 3 alertas');
  });

  it('o aviso imediato e o resumo diário: as contagens e a lista dos casos, cada um com o link dele', () => {
    const message = mail(criticalCases);
    expect(message.text).toContain(
      'Agora há 2 casos com 5 alertas críticos a validar. Os que receberam alerta por último:',
    );
    expect(message.text).toContain(
      [
        `- Vulnerabilidade em pacote: 4 alertas críticos e 1 alto: ${caseLink}`,
        `- Controle de segurança reprovado: 1 alerta crítico: ${caseLink}2`,
      ].join('\n'),
    );
    expect(message.html).toContain(
      `<li><a href="${caseLink}">Vulnerabilidade em pacote: 4 alertas críticos e 1 alto</a></li>`,
    );
    expect(message.text).toContain(`Ver a fila: ${queueLink}`);
    const summary = mail(daily).text;
    expect(summary).toContain('Vulnerabilidades: 1.250 casos com 40 alertas críticos e 2.100 altos.');
    expect(summary).toContain('Postura: 1 caso com 1 alerta alto.');
    expect(summary).toContain(`- Vulnerabilidade em pacote: 7 alertas altos: ${caseLink}`);
    // A fila vazia não aparece.
    expect(mail({ ...daily, posture: { cases: 0, critical: 0, high: 0 } }).text).not.toContain('Postura:');
    for (const notice of [criticalCases, daily])
      expect(mail(notice).text).toContain('aparecem só no painel, depois do login com MFA');
  });

  it('no resumo da hora, o item leva o título do caso e as contagens', () => {
    const message = digestMail('pessoa@cliente.example', 'Ana', {
      catchUp: false,
      hourStart: new Date('2026-11-05T17:00:00.000Z'),
      items: [
        opened,
        { ...opened, growth: true, severity: 'high' as const, critical: 0 },
        criticalCases,
        daily,
      ].map((notice) => ({ notice, at: new Date('2026-11-05T17:07:00.000Z') })),
      total: 4,
      panelLink: `${origin}/`,
    });
    expect(message.text).toContain(
      [
        `- 05/11/2026, 14:07 · Caso de severidade crítica: Atividade suspeita na conta da AWS, 3 alertas críticos e 12 altos: ${caseLink}`,
        `- 05/11/2026, 14:07 · Caso de severidade alta cresceu: Atividade suspeita na conta da AWS, 12 alertas altos: ${caseLink}`,
        `- 05/11/2026, 14:07 · Casos críticos novos de vulnerabilidade ou postura: 2 casos com 5 alertas críticos: ${queueLink}`,
        `- 05/11/2026, 14:07 · Resumo diário de vulnerabilidades e postura: 1.251 casos com 40 alertas críticos e 2.101 altos: ${queueLink}`,
      ].join('\n'),
    );
    expect(message.text).toContain('Minha conta');
  });

  it('o contato de escalonamento não recebe o título do caso nem a lista', () => {
    const unsubscribe = `${origin}/escalonamento/descadastrar#token=${'u'.repeat(43)}`;
    const one = escalationNoticeMail('contato@cliente.example', 'Ana', opened, unsubscribe);
    expect(one.subject).toBe('Caso de severidade crítica no Verax Control');
    expect(one.text).toContain('Um caso tem 3 alertas críticos e 12 altos a validar');
    expect(`${one.text}${one.html}`).not.toContain('Atividade suspeita');
    const many = escalationNoticeMail('contato@cliente.example', 'Ana', criticalCases, unsubscribe);
    expect(many.text).toContain('Agora há 2 casos com 5 alertas críticos a validar.');
    expect(`${many.text}${many.html}`).not.toContain('Vulnerabilidade em pacote');
    expect(many.text).not.toContain('por último');
    expect(many.html).toContain(unsubscribe);
  });

  it('um título hostil (que o dicionário nunca dá) não chega ao cabeçalho e vai escapado e limitado no corpo', () => {
    const title = `<img src=x>\r\nBcc: outra@exemplo.com ${'a'.repeat(400)}`;
    for (const notice of [
      { ...opened, title },
      { ...opened, growth: true, title },
      { ...criticalCases, items: [{ title, critical: 1, high: 0, link: caseLink }] },
      { ...daily, items: [{ title, critical: 1, high: 0, link: caseLink }] },
    ] as NoticeMail[]) {
      const message = mail(notice);
      expect(message.subject).not.toContain('Bcc');
      // eslint-disable-next-line no-control-regex -- confere que nenhum caractere de controle chega ao assunto
      expect(message.subject).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(message.html).not.toContain('<img');
      expect(message.html).toContain('&lt;img src=x&gt; Bcc: outra@exemplo.com');
      expect(message.text).not.toContain('\r\nBcc');
      expect(message.text).not.toContain('a'.repeat(200));
    }
  });
});
