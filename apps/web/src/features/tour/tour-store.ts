/**
 * Ligação entre o botão "Fazer o tour" (na faixa da demonstração, fora das rotas) e o tour (dentro do painel).
 * O botão só aparece quando há um tour montado para atender o pedido.
 */
type Listener = () => void;

const requestListeners = new Set<Listener>();
const hostListeners = new Set<Listener>();
let hosts = 0;

/** Pede ao tour do painel que abra (ou retome de onde parou). */
export function requestTour(): void {
  for (const listener of [...requestListeners]) listener();
}

export function onTourRequest(listener: Listener): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/** O tour do painel se registra enquanto está montado. */
export function registerTourHost(): () => void {
  hosts += 1;
  notifyHosts();
  return () => {
    hosts -= 1;
    notifyHosts();
  };
}

export function subscribeTourHosts(listener: Listener): () => void {
  hostListeners.add(listener);
  return () => {
    hostListeners.delete(listener);
  };
}

export function hasTourHost(): boolean {
  return hosts > 0;
}

function notifyHosts(): void {
  for (const listener of [...hostListeners]) listener();
}
