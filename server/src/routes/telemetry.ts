import type { FastifyInstance } from 'fastify';
import { telemetryReportSchema } from '@editify/shared';
import type { TelemetryService } from '../services/telemetry-service.js';

export function registerTelemetryRoutes(app: FastifyInstance, telemetry: TelemetryService): void {
  app.post('/telemetry', async (request) => {
    const report = telemetryReportSchema.parse(request.body);
    return await telemetry.ingest(report, request.userId);
  });
}
