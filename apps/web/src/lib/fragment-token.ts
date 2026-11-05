/**
 * Lê o token do fragmento da URL (`#token=…`) uma única vez e o apaga da barra de endereço, para ele não ficar no
 * histórico nem aparecer em captura de tela. O fragmento nunca é enviado a servidor nenhum: os links por e-mail (a
 * redefinição de senha e os do contato de escalonamento) levam o token nele.
 */
export function takeTokenFromFragment(): string | undefined {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? undefined;
  if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname);
  return token;
}
