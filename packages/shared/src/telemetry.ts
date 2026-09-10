import { z } from 'zod';

/** One line of the client's session log — `type` is a stable slug, `detail` free text. */
export const telemetryEventSchema = z.object({
  at: z.string().min(1),
  type: z.string().min(1).max(60),
  detail: z.string().max(400).optional(),
});
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/**
 * What the client posts to `POST /telemetry`. A 'session' report is just the
 * event log (it becomes a line in user-insights.md); 'error' and 'feedback'
 * carry something a human should act on, so they get assessed and filed.
 */
export const telemetryReportSchema = z.object({
  sessionId: z.string().min(1).max(64),
  kind: z.enum(['session', 'error', 'feedback']),
  events: z.array(telemetryEventSchema).max(200).default([]),
  error: z.object({ message: z.string().min(1).max(2000), stack: z.string().max(8000).optional() }).optional(),
  feedback: z.string().max(4000).optional(),
  platform: z.string().min(1).max(40),
  appVersion: z.string().max(40).optional(),
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
