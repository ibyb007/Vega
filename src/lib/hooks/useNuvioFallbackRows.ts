import { useQuery } from '@tanstack/react-query';
import { getNuvioHomeRows, NuvioHomeRow } from '../services/nuvioCatalog';

const EMPTY: NuvioHomeRow[] = [];

/**
 * Home rows from the Nuvio catalog. Only fetches while `enabled` is true,
 * i.e. when the active addon(s) produced no catalog rows of their own.
 */
export const useNuvioFallbackRows = (enabled: boolean) => {
  const query = useQuery<NuvioHomeRow[], Error>({
    queryKey: ['nuvioHomeRows'],
    queryFn: getNuvioHomeRows,
    enabled,
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return { rows: query.data ?? EMPTY, isLoading: query.isLoading };
};
