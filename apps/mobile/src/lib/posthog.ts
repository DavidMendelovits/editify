import PostHog from 'posthog-react-native';

/**
 * No token means no analytics, which is what a fresh clone, CI, and the web
 * export all want. Lifecycle events are on by default; JS crash capture is off
 * by default in the SDK, so it is turned on here. Screens are captured by hand
 * in the root layout because expo-router hides the navigation container.
 */
const token = process.env.EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN;

export const posthog = token
  ? new PostHog(token, {
      host: process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      errorTracking: { autocapture: { uncaughtExceptions: true, unhandledRejections: true } },
    })
  : undefined;
