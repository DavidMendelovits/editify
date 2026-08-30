import { randomUUID } from 'node:crypto';
import type { TelemetryReport } from '@editify/shared';
import type { EditifyDatabase } from './database.js';

/** A filed report's GitHub issue, once it has one. */
export interface StoredIssue { issueNumber: number; issueUrl: string }

export class ReportStore {
  constructor(private readonly database: EditifyDatabase) {}

  insert(report: TelemetryReport, userId?: string, fingerprint?: string): string {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO reports (id, session_id, user_id, kind, payload_json, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, report.sessionId, userId ?? null, report.kind, JSON.stringify(report), fingerprint ?? null, new Date().toISOString());
    return id;
  }

  /** The issue an identical error already opened, so repeats do not file again. */
  findIssue(fingerprint: string): StoredIssue | undefined {
    const row = this.database.prepare(`
      SELECT issue_number, issue_url FROM reports
      WHERE fingerprint = ? AND issue_number IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(fingerprint) as { issue_number: number; issue_url: string } | undefined;
    return row ? { issueNumber: row.issue_number, issueUrl: row.issue_url } : undefined;
  }

  attachIssue(id: string, issue: StoredIssue): void {
    this.database.prepare('UPDATE reports SET issue_number = ?, issue_url = ? WHERE id = ?')
      .run(issue.issueNumber, issue.issueUrl, id);
  }
}
