import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type NotificationPreferencesUpdate, notificationPreferencesSchema } from '@verax/shared';
import { api } from '@/lib/api';

const PREFERENCES_KEY = ['notification-preferences'] as const;
const PATH = '/v1/notification-preferences';

/** A preferência de aviso por e-mail da própria pessoa (fase 2, PR-17'). */
export function useNotificationPreferences() {
  return useQuery({ queryKey: PREFERENCES_KEY, queryFn: () => api.get(PATH, notificationPreferencesSchema) });
}

/** Muda a própria preferência. A lista de usuários (coluna "Recebe alertas") é relida. */
export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NotificationPreferencesUpdate) => api.put(PATH, input, notificationPreferencesSchema),
    onSuccess: (saved) => {
      queryClient.setQueryData(PREFERENCES_KEY, saved);
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
}
