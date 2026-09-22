import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PostHogProvider } from 'posthog-react-native';
import { useState, type PropsWithChildren } from 'react';
import { ErrorReporter } from '../components/ErrorReporter';
import { posthog } from '../lib/posthog';

export function AppProviders({ children }: PropsWithChildren) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 3_000, retry: 1 },
      mutations: { retry: 0 },
    },
  }));
  // Inside the query provider: the report modal posts through react-query.
  const content = <ErrorReporter>{children}</ErrorReporter>;
  return (
    <QueryClientProvider client={client}>
      {posthog ? <PostHogProvider client={posthog}>{content}</PostHogProvider> : content}
    </QueryClientProvider>
  );
}
