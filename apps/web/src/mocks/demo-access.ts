/**
 * O acesso de demonstração: o e-mail, a senha, o código do MFA e a senha temporária que o mock aceita. São fictícios e
 * não valem fora do mock do navegador. A tela de login do build de demonstração os mostra e os preenche
 * (`features/demo-login`); como este módulo só é importado pelo mock e por ela, não chega ao build de produção.
 */
export const DEMO_ACCESS = {
  email: 'analista@demo.verax.local',
  password: 'senha-de-demonstracao',
  /** Primeiro acesso: com ela, a sessão só alcança a troca de senha (e, depois, o cadastro do MFA). */
  temporaryPassword: 'senha-temporaria-demonstracao',
  totp: '123456',
};
