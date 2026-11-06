import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import type { IdTokenSource } from '../status/id-token.js';

/**
 * O token de identidade da conta do próprio serviço pelo `google-auth-library` (no Cloud Run, a `cp-admin`, pelo
 * servidor de metadados, com `format=full`: o e-mail e o `email_verified` que o cp-worker confere), para o console
 * chamar as operações do responsável no cp-worker (`worker-owner-client.ts`). A biblioteca guarda o token até perto do
 * vencimento. Nunca o JWT do IAP de quem está no navegador: esse não sai do cp-admin. A mensagem de erro da biblioteca
 * (que pode citar um caminho de credencial) não sai daqui.
 */
export class GoogleAuthIdTokenSource implements IdTokenSource {
  private auth: GoogleAuth | undefined;
  private readonly clients = new Map<string, Promise<IdTokenClient>>();

  async get(audience: string): Promise<string> {
    this.auth ??= new GoogleAuth();
    let client = this.clients.get(audience);
    if (client === undefined) {
      client = this.auth.getIdTokenClient(audience);
      this.clients.set(audience, client);
    }
    let header: string | null;
    try {
      header = (await (await client).getRequestHeaders()).get('authorization');
    } catch {
      this.clients.delete(audience);
      throw new Error('token de identidade indisponível');
    }
    const token = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : '';
    if (token.split('.').length !== 3) throw new Error('token de identidade fora do formato');
    return token;
  }
}
