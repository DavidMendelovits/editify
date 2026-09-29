import { QueryClientProvider } from '@tanstack/react-query';
import { PostHogProvider } from 'posthog-react-native';
import type { PropsWithChildren } from 'react';
import { ErrorReporter } from '../components/ErrorReporter';
import { posthog } from '../lib/posthog';
import { queryClient } from '../lib/query-client';

export function AppProviders({ children }: PropsWithChildren) {
  // Inside the query provider: the report modal posts through react-query.
  const content = <ErrorReporter>{children}</ErrorReporter>;
  return (
    <QueryClientProvider client={queryClient}>
      {posthog ? <PostHogProvider client={posthog} autocapture={{ captureScreens: false }}>{content}</PostHogProvider> : content}
    </QueryClientProvider>
  );
}
