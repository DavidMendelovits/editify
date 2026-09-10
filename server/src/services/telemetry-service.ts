import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TelemetryEvent, TelemetryReceipt, TelemetryReport } from '@editify/shared';
import type { ToolProvider } from '../agent/providers.js';
import { dataRoot } from '../config.js';
import type { ReportStore, StoredIssue } from '../db/report-store.js';
import { NO_DASHES_RULE } from '../agent/prose-style.js';

const GITHUB_REPO = 'DavidMendelovits/editify';

/** Title plus the feasibility paragraph that goes at the top of the issue. */
interface Assessment { title: string; feasibility: string }

function summarize(events: TelemetryEvent[]): string {
  if (!events.length) return 'no events';
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => (count > 1 ? `${type} ×${count}` : type)).join(', ');
}

/**
 * Session logs, crashes, and feedback from the client. Everything is stored
 * first, so a missing `GITHUB_TOKEN` or a GitHub outage costs a report nothing —
 * it just lands in user-insights.md for a human instead of in the tracker.
 */
export class TelemetryService {
  constructor(
    private readonly store: ReportStore,
    /** Resolved per call, like the other services, so the provider picker applies live. */
    private readonly provider: () => Promise<ToolProvider>,
    private readonly insightsPath = join(dataRoot, 'user-insights.md'),
  ) {}

  async ingest(report: TelemetryReport, userId?: string): Promise<TelemetryReceipt> {
    const fingerprint = report.error ? createHash('sha256').update(report.error.message).digest('hex').slice(0, 16) : undefined;
    const reportId = this.store.insert(report, userId, fingerprint);

    if (report.kind === 'session') {
      this.appendInsight(`## Session ${report.sessionId} · ${report.platform}`, [`Events: ${summarize(report.events)}`]);
      return { reportId, issueNumber: null, issueUrl: null, note: 'Session logged for review.' };
    }

    const known = fingerprint ? this.store.findIssue(fingerprint) : undefined;
    if (known) {
      this.store.attachIssue(reportId, known);
      return { reportId, ...known, note: 'Already tracked, added to the open issue.' };
    }

    const assessment = await this.assess(report);
    const issue = await this.file(report, assessment);
    if (!issue) {
      this.appendInsight(`## ${assessment.title}`, [
        assessment.feasibility,
        ...this.details(report),
        '_Not filed on GitHub: GITHUB_TOKEN is unset or the API call failed._',
      ]);
      return { reportId, issueNumber: null, issueUrl: null, note: 'Logged for review. We could not open a tracker issue.' };
    }
    this.store.attachIssue(reportId, issue);
    return { reportId, ...issue, note: 'Filed as an issue.' };
  }

  /**
   * A short title and a feasibility read from the LLM, with a template fallback
   * so a missing or broken provider never blocks the report.
   */
  private async assess(report: TelemetryReport): Promise<Assessment> {
    const subject = report.error?.message ?? report.feedback ?? 'Unspecified report';
    const system = [
      'You triage bug reports and feature requests for a video-editing app.',
      'Return only one JSON object: {"title": string, "feasibility": string}.',
      'Title is under 80 characters and names the problem or request.',
      'Feasibility is one short paragraph: the likely cause or change, and how hard it looks.',
      NO_DASHES_RULE,
    ].join(' ');
    try {
      const provider = await this.provider();
      const raw = await provider.completeText(system, JSON.stringify({
        kind: report.kind,
        platform: report.platform,
        ...(report.appVersion ? { appVersion: report.appVersion } : {}),
        ...(report.error ? { error: report.error } : {}),
        ...(report.feedback ? { feedback: report.feedback } : {}),
        recentEvents: report.events.slice(-20),
      }));
      const parsed = JSON.parse(raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? raw.trim()) as Partial<Assessment>;
      if (typeof parsed.title === 'string' && typeof parsed.feasibility === 'string' && parsed.title.trim()) {
        return { title: parsed.title.slice(0, 120), feasibility: parsed.feasibility };
      }
    } catch (error) {
      console.warn('[telemetry] feasibility assessment fell back to the template:', error);
    }
    return {
      title: `${report.kind === 'error' ? 'Crash' : 'Feedback'}: ${subject.split('\n')[0]?.slice(0, 90) ?? subject}`,
      feasibility: 'Not assessed automatically: no LLM provider was reachable. Triage by hand.',
    };
  }

  /** `null` whenever nothing reached GitHub; the caller falls back to the file. */
  private async file(report: TelemetryReport, assessment: Assessment): Promise<StoredIssue | undefined> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.warn('[telemetry] GITHUB_TOKEN is unset, storing the report locally instead of filing an issue.');
      return undefined;
    }
    try {
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: assessment.title,
          body: [`**Feasibility.** ${assessment.feasibility}`, ...this.details(report)].join('\n\n'),
          labels: ['user-report'],
        }),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${await response.text()}`);
      const issue = await response.json() as { number: number; html_url: string };
      return { issueNumber: issue.number, issueUrl: issue.html_url };
    } catch (error) {
      console.warn('[telemetry] could not open a GitHub issue:', error);
      return undefined;
    }
  }

  private details(report: TelemetryReport): string[] {
    return [
      ...(report.error ? [`**Error.** \`${report.error.message}\``] : []),
      ...(report.error?.stack ? ['```\n' + report.error.stack.slice(0, 4000) + '\n```'] : []),
      ...(report.feedback ? [`**What the user said.** ${report.feedback}`] : []),
      `**Session.** ${report.sessionId} · ${report.platform}${report.appVersion ? ` · v${report.appVersion}` : ''}`,
      `**Events.** ${summarize(report.events)}`,
    ];
  }

  private appendInsight(heading: string, lines: string[]): void {
    try {
      mkdirSync(dirname(this.insightsPath), { recursive: true });
      appendFileSync(this.insightsPath, `\n${heading}\n\n_${new Date().toISOString()}_\n\n${lines.join('\n\n')}\n`);
    } catch (error) {
      console.warn('[telemetry] could not append to user-insights.md:', error);
    }
  }
}
