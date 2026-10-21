import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addLead,
  getLeads,
  updateLeadStage,
  deleteLead,
  scheduleAction,
  getAutomationQueue,
  deleteQueueItem,
  markDeadLeads,
  Lead,
  CreateLeadInput,
  EnrichedAutomationQueueItem,
  ScheduleActionInput,
  DeleteResult,
} from '../api/db';

export const LEADS_QUERY_KEY = ['leads'] as const;
export const AUTOMATION_QUEUE_QUERY_KEY = ['automation_queue'] as const;

export function useLeadsQuery() {
  return useQuery<Lead[], Error>({
    queryKey: LEADS_QUERY_KEY,
    queryFn: async () => {
      return await getLeads();
    },
  });
}

export function useAddLeadMutation() {
  const queryClient = useQueryClient();

  return useMutation<Lead, Error, CreateLeadInput>({
    mutationFn: async (input: CreateLeadInput) => {
      return await addLead(input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    },
  });
}

export function useUpdateLeadStageMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    { updated: boolean; id: string; funnel_stage: string },
    Error,
    { id: string; stage: string }
  >({
    mutationFn: async ({ id, stage }) => {
      return await updateLeadStage(id, stage);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    },
  });
}

export function useDeleteLeadMutation() {
  const queryClient = useQueryClient();

  return useMutation<DeleteResult, Error, string>({
    mutationFn: async (id: string) => {
      return await deleteLead(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: AUTOMATION_QUEUE_QUERY_KEY });
    },
  });
}

export function useAutomationQueueQuery() {
  return useQuery<EnrichedAutomationQueueItem[], Error>({
    queryKey: AUTOMATION_QUEUE_QUERY_KEY,
    queryFn: async () => {
      return await getAutomationQueue();
    },
    refetchInterval: 10000, // auto-refresh queue every 10 seconds
  });
}

export function useScheduleActionMutation() {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, ScheduleActionInput>({
    mutationFn: async (input: ScheduleActionInput) => {
      return await scheduleAction(input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AUTOMATION_QUEUE_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    },
  });
}

export function useDeleteQueueItemMutation() {
  const queryClient = useQueryClient();

  return useMutation<DeleteResult, Error, string>({
    mutationFn: async (id: string) => {
      return await deleteQueueItem(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AUTOMATION_QUEUE_QUERY_KEY });
    },
  });
}

export function useMarkDeadLeadsMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ marked_cold_count: number; days: number }, Error, number | undefined>({
    mutationFn: async (days) => {
      return await markDeadLeads(days);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    },
  });
}
