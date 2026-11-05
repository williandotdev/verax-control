import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type EscalationContactInput,
  escalationContactResponseSchema,
  type EscalationLinkResult,
  escalationLinkResultSchema,
  tenantSchema,
} from '@verax/shared';
import { api } from '@/lib/api';

/**
 * Contato de escalonamento (D8): a tela do administrador do cliente (`/v1/escalation-contact`, sempre o cliente da
 * sessão), o reenvio da confirmação no cadastro de clientes da Verax e os links públicos do e-mail.
 */

const CONTACT_KEY = ['escalation-contact'] as const;
const PATH = '/v1/escalation-contact';

export function useEscalationContact(enabled = true) {
  return useQuery({
    queryKey: CONTACT_KEY,
    queryFn: () => api.get(PATH, escalationContactResponseSchema),
    enabled,
  });
}

/** Troca o contato. Endereço novo volta a aguardar a confirmação (o e-mail sai pelo worker). */
export function useUpdateEscalationContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: EscalationContactInput) => api.put(PATH, input, escalationContactResponseSchema),
    onSuccess: (saved) => queryClient.setQueryData(CONTACT_KEY, saved),
  });
}

/** Pede a confirmação de novo (aguardando ou descadastrado). */
export function useRequestEscalationConfirmation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`${PATH}/confirmation`, undefined, escalationContactResponseSchema),
    onSuccess: (saved) => queryClient.setQueryData(CONTACT_KEY, saved),
  });
}

/** O reenvio pelo cadastro de clientes da Verax: devolve o cadastro, que a tela relê. */
export function useRequestTenantEscalationConfirmation(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post(
        `/v1/tenants/${encodeURIComponent(tenantId)}/escalation-contact/confirmation`,
        undefined,
        tenantSchema,
      ),
    onSuccess: (tenant) => queryClient.setQueryData(['admin-tenant', tenantId], tenant),
  });
}

/** Os links do e-mail, sem sessão: o token vai no corpo, e a resposta é só o estado novo. */
export function followEscalationLink(
  action: 'confirm' | 'unsubscribe',
  token: string,
): Promise<EscalationLinkResult> {
  return api.post(`/v1/public/escalation-contact/${action}`, { token }, escalationLinkResultSchema);
}
