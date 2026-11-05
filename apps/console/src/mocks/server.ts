import { setupServer } from 'msw/node';
import { adminHandlers } from './handlers';

/** O servidor do MSW dos testes de componente; cada teste pode trocar o estado com `server.use(...adminHandlers(...))`. */
export const server = setupServer(...adminHandlers());
