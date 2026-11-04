import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { API_ADDRESS } from './lib/env';
import { UnknownAddressPage } from './pages/unknown-address-page';

async function start(): Promise<void> {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Elemento #root não encontrado');

  // Build único aberto fora do endereço de um cliente: nenhuma API derivada e nenhuma chamada, só o aviso.
  if (!API_ADDRESS.ok) {
    createRoot(rootElement).render(
      <StrictMode>
        <UnknownAddressPage />
      </StrictMode>,
    );
    return;
  }

  // Modo `dev:mock`: a API é simulada no navegador com dados fictícios. Em qualquer outro modo este ramo
  // some do build.
  if (import.meta.env.MODE === 'mock') {
    const { enableMocks } = await import('./mocks/enable');
    await enableMocks();
  }

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
