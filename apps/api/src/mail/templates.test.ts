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
const incidentLink = `${origin}/incidentes/018f2c1e-0000-7000-8000-0000000000c1`;

const notices: NoticeMail[] = [
  { kind: 'incident_opened', severity: 'high', link: incidentLink },
  { kind: 'incident_opened', severity: 'critical', link: incidentLink },
  { kind: 'incident_escalated', severity: 'high', link: incidentLink },
  { kind: 'incident_escalated', severity: 'critical', link: incidentLink },
  { kind: 'critical_finding', link: `${origin}/achados?achado=018f2c1e-0000-7000-8000-0000000000f1` },
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
];

describe('e-mail dos avisos (PR-16)', () => {
  it('assunto fixo por tipo e severidade, numa linha só', () => {
    const subjects = notices.map((notice) => noticeMail('pessoa@cliente.example', 'Ana', notice).subject);
    expect(subjects).toEqual([
      'Incidente de severidade alta aberto no Verax Control',
      'Incidente de severidade crítica aberto no Verax Control',
      'Incidente subiu para severidade alta no Verax Control',
      'Incidente subiu para severidade crítica no Verax Control',
      'Achado de severidade crítica no Verax Control',
      'Coleta da AWS parada no Verax Control',
      '80% do volume mensal do plano no Verax Control',
      'Volume mensal do plano atingido no Verax Control',
    ]);
    // eslint-disable-next-line no-control-regex -- confere que nenhum caractere de controle chega ao assunto
    for (const subject of subjects) expect(subject).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('o assunto não muda com o nome de quem recebe, nem com quebra de linha nele', () => {
    const notice = notices[0] as NoticeMail;
    const message = noticeMail('pessoa@cliente.example', 'Ana\r\nBcc: outra@exemplo.com', notice);
    expect(message.subject).toBe('Incidente de severidade alta aberto no Verax Control');
    expect(message.to).toBe('pessoa@cliente.example');
  });

  it('HTML escapado: o nome de quem recebe não vira marcação, e o link vai no href escapado', () => {
    const message = noticeMail('pessoa@cliente.example', '<script>alert("x")</script> & \'Bia\'', {
      kind: 'critical_finding',
      link: `${origin}/achados?achado=1&x="><img src=x>`,
    });
    expect(message.html).toContain(
      '<p>Olá, &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Bia&#39;.</p>',
    );
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain(
      `<a href="${origin}/achados?achado=1&amp;x=&quot;&gt;&lt;img src=x&gt;">Ver o achado</a>`,
    );
    // O texto puro leva o nome e o link como vieram (não é HTML).
    expect(message.text).toContain('Olá, <script>');
  });

  it('o corpo é só o texto fixo do tipo e o link: nada do achado, do incidente ou da conta', () => {
    const message = noticeMail('pessoa@cliente.example', 'Ana', notices[1] as NoticeMail);
    expect(message.text).toBe(
      [
        'Olá, Ana.',
        'Um incidente de severidade crítica foi aberto.',
        'Por segurança, os detalhes (contas, recursos, IPs e identidades) aparecem só no painel, depois do login com MFA.',
        `Ver o incidente: ${incidentLink}`,
        'Você recebe este aviso por ter acesso a este cliente no Verax Control.',
        'Para não receber mais os avisos de incidente por e-mail, desligue a opção em Minha conta, no painel.',
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
    ]);
  });

  it('volume do plano: o mês por extenso e a coleta que continua', () => {
    const eighty = noticeMail('admin@cliente.example', 'Ana', notices[6] as NoticeMail);
    expect(eighty.text).toContain(
      'O volume de logs lido em novembro de 2026 chegou a 80% do limite mensal do plano.',
    );
    const hundred = noticeMail('admin@cliente.example', 'Ana', notices[7] as NoticeMail);
    expect(hundred.text).toContain('chegou ao limite mensal do plano');
    expect(hundred.text).toContain('A coleta, os achados e os incidentes continuam normalmente.');
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
          `- 05/11/2026, 14:07 · Incidente de severidade crítica aberto: ${incidentLink}`,
          `- 05/11/2026, 14:32 · Achado de severidade crítica: ${origin}/achados?achado=018f2c1e-0000-7000-8000-0000000000f1`,
        ].join('\n'),
        'Por segurança, os detalhes (contas, recursos, IPs e identidades) aparecem só no painel, depois do login com MFA.',
        'Você recebe este resumo por ter acesso a este cliente no Verax Control.',
        'Para não receber mais os avisos de incidente por e-mail, desligue a opção em Minha conta, no painel.',
        'Verax Control',
      ].join('\n\n'),
    );
    expect(message.html).toContain(
      `<li>05/11/2026, 14:07 · <a href="${incidentLink}">Incidente de severidade crítica aberto</a></li>`,
    );
    expect(message.text).not.toContain('E mais');
  });

  it('passa da lista: "e mais N", com o link do painel', () => {
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
      items: [item({ kind: 'critical_finding', link: `${origin}/achados?achado=1&x="><script>` }, 1)],
      total: 12,
      panelLink: `${origin}/"><script>`,
    });
    expect(message.html).toContain('<p>Olá, &lt;img src=x onerror=alert(1)&gt; &amp; &#39;Bia&#39;.</p>');
    expect(message.html).not.toContain('<img');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain(`href="${origin}/achados?achado=1&amp;x=&quot;&gt;&lt;script&gt;"`);
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
    { kind: 'critical_finding', link: `${origin}/achados?achado=018f2c1e-0000-7000-8000-0000000000f1` },
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
        'Este endereço foi cadastrado como contato de escalonamento no Verax Control, o painel de segurança em nuvem da Verax. Se você confirmar, vai receber por e-mail só os avisos críticos (incidente de severidade crítica e achado crítico), sem detalhes: eles ficam no painel, para quem tem acesso.',
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
      'Incidente de severidade crítica aberto no Verax Control',
      'Incidente subiu para severidade crítica no Verax Control',
      'Achado de severidade crítica no Verax Control',
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
        'Um incidente de severidade crítica foi aberto.',
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
