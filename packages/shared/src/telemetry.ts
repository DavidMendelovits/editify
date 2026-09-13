import { z } from 'zod';

/** One line of the client's session log — `type` is a stable slug, `detail` free text. */
export const telemetryEventSchema = z.object({
  at: z.string().min(1),
  type: z.string().min(1).max(60),
  detail: z.string().max(400).optional(),
});
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/**
 * The browser or device the report came from. Every field is optional: a report
 * from a runtime that cannot answer a given question is still worth filing, and
 * an older client sends none of this at all.
 */
export const telemetryEnvironmentSchema = z.object({
  /** Raw UA string on web. The server turns it into a readable browser and OS line. */
  userAgent: z.string().max(400).optional(),
  language: z.string().max(40).optional(),
  timezone: z.string().max(60).optional(),
  /** Physical screen and the window the app actually drew into, as `1440x900`. */
  screen: z.string().max(40).optional(),
  viewport: z.string().max(40).optional(),
  pixelRatio: z.number().min(0).max(16).optional(),
  colorScheme: z.enum(['light', 'dark']).optional(),
  reducedMotion: z.boolean().optional(),
  touch: z.boolean().optional(),
  online: z.boolean().optional(),
  /** Effective connection type where the browser exposes it, such as `4g`. */
  connection: z.string().max(40).optional(),
  deviceMemoryGb: z.number().min(0).max(1024).optional(),
  cpuCores: z.number().int().min(0).max(1024).optional(),
  /** Path only, never the query string: a project id is context, a token is not. */
  path: z.string().max(200).optional(),
  /** Whole seconds between the session's first event and this report. */
  sessionSeconds: z.number().int().min(0).optional(),
});
export type TelemetryEnvironment = z.infer<typeof telemetryEnvironmentSchema>;

/**
 * What the app was showing when the report was sent: the screen, the project,
 * the size of the timeline, whatever the current screen chose to publish. Free
 * form on purpose so a screen can add a field without a schema change.
 */
export const telemetryContextSchema = z
  .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 30, { message: 'at most 30 context entries' });
export type TelemetryContext = z.infer<typeof telemetryContextSchema>;

/**
 * What the client posts to `POST /telemetry`. A 'session' report is just the
 * event log (it becomes a line in user-insights.md); 'error' and 'feedback'
 * carry something a human should act on, so they get assessed and filed.
 */
export const telemetryReportSchema = z.object({
  sessionId: z.string().min(1).max(64),
  kind: z.enum(['session', 'error', 'feedback']),
  events: z.array(telemetryEventSchema).max(200).default([]),
  error: z.object({
    message: z.string().min(1).max(2000),
    stack: z.string().max(8000).optional(),
    /** React's own trace: which components were mounted around the failure. */
    componentStack: z.string().max(4000).optional(),
  }).optional(),
  feedback: z.string().max(4000).optional(),
  platform: z.string().min(1).max(40),
  appVersion: z.string().max(40).optional(),
  environment: telemetryEnvironmentSchema.optional(),
  context: telemetryContextSchema.optional(),
});
export type TelemetryReport = z.infer<typeof telemetryReportSchema>;

/**
 * The POST's answer. `issueNumber` is null whenever nothing reached GitHub —
 * no token, an API failure, or a plain session report — and `note` is the one
 * line the client shows the user in that case.
 */
export interface TelemetryReceipt {
  reportId: string;
  issueNumber: number | null;
  issueUrl: string | null;
  note: string;
}
