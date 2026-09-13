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

  /** The rebuildable state a report was sent from, kept whole even when the issue only summarises it. */
  attachRepro(id: string, bundle: unknown): void {
    this.database.prepare('UPDATE reports SET repro_json = ? WHERE id = ?').run(JSON.stringify(bundle), id);
  }

  /** What `npm run repro` reads. */
  getRepro(id: string): unknown | undefined {
    const row = this.database.prepare('SELECT repro_json FROM reports WHERE id = ?').get(id) as { repro_json: string | null } | undefined;
    return row?.repro_json ? JSON.parse(row.repro_json) : undefined;
  }

  /** The newest report filed against an issue, for looking a repro up by issue number. */
  findByIssue(issueNumber: number): string | undefined {
    const row = this.database.prepare(
      'SELECT id FROM reports WHERE issue_number = ? ORDER BY created_at DESC LIMIT 1',
    ).get(issueNumber) as { id: string } | undefined;
    return row?.id;
  }

  attachIssue(id: string, issue: StoredIssue): void {
    this.database.prepare('UPDATE reports SET issue_number = ?, issue_url = ? WHERE id = ?')
      .run(issue.issueNumber, issue.issueUrl, id);
  }
}
