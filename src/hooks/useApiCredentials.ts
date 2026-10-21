import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createApiCredential,
  deleteApiCredential,
  getApiCredentials,
  ApiCredential,
  CreateApiCredentialInput,
  DeleteResult,
} from '../api/db';

export const API_CREDENTIALS_QUERY_KEY = ['api_credentials'] as const;

/**
 * Hook to fetch all registered LLM API credentials
 */
export function useApiCredentialsQuery() {
  return useQuery<ApiCredential[], Error>({
    queryKey: API_CREDENTIALS_QUERY_KEY,
    queryFn: async () => {
      return await getApiCredentials();
    },
  });
}

/**
 * Hook to register a new API credential
 */
export function useCreateApiCredentialMutation() {
  const queryClient = useQueryClient();

  return useMutation<ApiCredential, Error, CreateApiCredentialInput>({
    mutationFn: async (input: CreateApiCredentialInput) => {
      return await createApiCredential(input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: API_CREDENTIALS_QUERY_KEY });
    },
  });
}

/**
 * Hook to delete an API credential by its UUID
 */
export function useDeleteApiCredentialMutation() {
  const queryClient = useQueryClient();

  return useMutation<DeleteResult, Error, string>({
    mutationFn: async (id: string) => {
      return await deleteApiCredential(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: API_CREDENTIALS_QUERY_KEY });
    },
  });
}
