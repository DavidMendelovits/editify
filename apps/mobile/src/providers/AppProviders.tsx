import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type PropsWithChildren } from 'react';

export function AppProviders({ children }: PropsWithChildren) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 3_000, retry: 1 },
      mutations: { retry: 0 },
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
