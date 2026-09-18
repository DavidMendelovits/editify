import type { FastifyInstance } from 'fastify';
import { telemetryReportSchema } from '@editify/shared';
import type { TelemetryService } from '../services/telemetry-service.js';

/**
 * A report with an attached screenshot is a few hundred KB of base64, well past
 * Fastify's 1MB default once the rest of the payload is on top of it. The
 * schema caps the image itself at 1.5M characters.
 */
const TELEMETRY_BODY_LIMIT = 4 * 1024 * 1024;

export function registerTelemetryRoutes(app: FastifyInstance, telemetry: TelemetryService): void {
  app.post('/telemetry', { bodyLimit: TELEMETRY_BODY_LIMIT }, async (request) => {
    const report = telemetryReportSchema.parse(request.body);
    return await telemetry.ingest(report, request.userId);
  });
}
