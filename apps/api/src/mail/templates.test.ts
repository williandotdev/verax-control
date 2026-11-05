import { describe, expect, it } from 'vitest';
import { type NoticeMail, noticeMail } from './templates.js';

const origin = 'https://cliente.control.exemplo.com.br';
const incidentLink = `${origin}/incidentes/018f2c1e-0000-7000-8000-0000000000c1`;

const notices: NoticeMail[] = [
  { kind: 'incident_opened', severity: 'high', link: incidentLink },
  { kind: 'incident_opened', severity: 'critical', link: incidentLink },
  { kind: 'incident_escalated', severity: 'high', link: incidentLink },
  { kind: 'incident_escalated', severity: 'critical', link: incidentLink },
  { kind: 'critical_finding', link: `${origin}/achados?achado=018f2c1e-0000-7000-8000-0000000000f1` },
  { kind: 'aws_ingestion_stalled', link: `${origin}/cadastros/contas` },
  { kind: 'plan_usage', percent: 80, month: new Date('2026-11-01T00:00:00.000Z'), link: `${origin}/` },
  { kind: 'plan_usage', percent: 100, month: new Date('2026-11-01T00:00:00.000Z'), link: `${origin}/` },
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
        'Verax Control',
      ].join('\n\n'),
    );
    expect(message.html).toContain(`<a href="${incidentLink}">Ver o incidente</a>`);
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
