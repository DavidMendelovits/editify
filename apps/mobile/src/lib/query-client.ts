import { QueryClient } from '@tanstack/react-query';

/** The app's one cache, module-level so the root layout can drop it on a user change. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 3_000, retry: 1 },
    mutations: { retry: 0 },
  },
});

let cachedFor: string | undefined;

/**
 * A different account must never see the last one's library, not even for a
 * frame, so call this before the new session renders.
 */
export function scopeCacheTo(userId: string | undefined, client: QueryClient = queryClient): void {
  if (userId !== cachedFor) client.clear();
  cachedFor = userId;
}
