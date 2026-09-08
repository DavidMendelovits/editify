import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type PropsWithChildren } from 'react';
import { ErrorReporter } from '../components/ErrorReporter';

export function AppProviders({ children }: PropsWithChildren) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 3_000, retry: 1 },
      mutations: { retry: 0 },
    },
  }));
  // Inside the query provider: the report modal posts through react-query.
  return <QueryClientProvider client={client}><ErrorReporter>{children}</ErrorReporter></QueryClientProvider>;
}
