import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

async function start(): Promise<void> {
  // Modo `dev:mock`: a API é simulada no navegador com dados fictícios. Em qualquer outro modo este ramo
  // some do build.
  if (import.meta.env.MODE === 'mock') {
    const { enableMocks } = await import('./mocks/enable');
    await enableMocks();
  }

  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Elemento #root não encontrado');

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
