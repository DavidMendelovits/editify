import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TelemetryEnvironment, TelemetryEvent, TelemetryReceipt, TelemetryReport } from '@editify/shared';
import type { ToolProvider } from '../agent/providers.js';
import { dataRoot } from '../config.js';
import type { ReportStore, StoredIssue } from '../db/report-store.js';
import type { ReproBundle, ReproService } from './repro-service.js';
import { storeScreenshot, type StoredScreenshot } from './report-media.js';
import { NO_DASHES_RULE } from '../agent/prose-style.js';

const GITHUB_REPO = 'DavidMendelovits/editify';
/** How many log lines the issue prints in full before it falls back to the counts. */
const TIMELINE_LINES = 30;
/**
 * GitHub rejects an issue body over 65536 characters with a 422, which would
 * lose the whole report. Every part can grow (a stack, a component stack, a
 * timeline, a repro bundle), so the body is assembled and then measured, and
 * the bundle is the piece that gives way: it stays whole on the report row for
 * `npm run repro` either way.
 */
const GITHUB_BODY_LIMIT = 65_536;

/** Title plus the feasibility paragraph that goes at the top of the issue. */
interface Assessment { title: string; feasibility: string; area?: string }

function summarize(events: TelemetryEvent[]): string {
  if (!events.length) return 'no events';
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => (count > 1 ? `${type} ×${count}` : type)).join(', ');
}

/** `2026-09-13T10:04:02Z` becomes `-12.4s` against the newest event in the log. */
function relative(at: string, end: number): string {
  const stamp = Date.parse(at);
  if (Number.isNaN(stamp)) return at;
  const delta = (stamp - end) / 1000;
  return `${delta <= 0 ? '' : '+'}${delta.toFixed(1)}s`;
}

/**
 * The event log as a readable trail: newest last, each line stamped against the
 * moment the report was sent, so "what happened just before this" is one glance.
 */
function timeline(events: TelemetryEvent[]): string[] {
  if (!events.length) return [];
  const shown = events.slice(-TIMELINE_LINES);
  const end = Date.parse(shown.at(-1)?.at ?? '') || Date.now();
  const lines = shown.map((event) => `${relative(event.at, end).padStart(8)}  ${event.type}${event.detail ? `  ${event.detail}` : ''}`);
  const omitted = events.length - shown.length;
  return [[
    '**What led up to it.**',
    '```',
    ...(omitted > 0 ? [`(${omitted} earlier ${omitted === 1 ? 'event' : 'events'} not shown)`] : []),
    ...lines,
    '```',
  ].join('\n')];
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\/([\d.]+)/, 'Edge'],
  [/OPR\/([\d.]+)/, 'Opera'],
  [/Firefox\/([\d.]+)/, 'Firefox'],
  [/Chrome\/([\d.]+)/, 'Chrome'],
  [/Version\/([\d.]+).*Safari/, 'Safari'],
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone OS ([\d_]+)/, 'iOS'],
  [/iPad;.*OS ([\d_]+)/, 'iPadOS'],
  [/Android ([\d.]+)/, 'Android'],
  [/Mac OS X ([\d_]+)/, 'macOS'],
  [/Windows NT ([\d.]+)/, 'Windows'],
  [/(Linux)/, 'Linux'],
];

/** `Chrome 141 on macOS 14.6`: the one line a triager actually reads a UA for. */
function describeAgent(userAgent: string): string {
  const read = (table: Array<[RegExp, string]>): string | undefined => {
    for (const [pattern, name] of table) {
      const match = pattern.exec(userAgent);
      if (match) {
        const version = match[1]?.replace(/_/g, '.');
        return version && version !== name ? `${name} ${version.split('.').slice(0, 2).join('.')}` : name;
      }
    }
    return undefined;
  };
  return [read(BROWSERS), read(SYSTEMS)].filter(Boolean).join(' on ') || 'unrecognised client';
}

/** Environment fields as a bullet list, skipping everything the client could not answer. */
function describeEnvironment(environment: TelemetryEnvironment | undefined): string[] {
  if (!environment) return [];
  const rows: Array<[string, string | undefined]> = [
    ['Client', environment.userAgent ? describeAgent(environment.userAgent) : undefined],
    ['Viewport', environment.viewport
      ? `${environment.viewport}${environment.screen ? ` (screen ${environment.screen})` : ''}${environment.pixelRatio ? ` @${environment.pixelRatio}x` : ''}`
      : undefined],
    ['Route', environment.path],
    ['Locale', [environment.language, environment.timezone].filter(Boolean).join(', ') || undefined],
    ['Appearance', [
      environment.colorScheme,
      environment.reducedMotion ? 'reduced motion' : undefined,
      environment.touch === undefined ? undefined : environment.touch ? 'touch' : 'no touch',
    ].filter(Boolean).join(', ') || undefined],
    ['Network', [
      environment.online === undefined ? undefined : environment.online ? 'online' : 'offline',
      environment.connection,
    ].filter(Boolean).join(', ') || undefined],
    ['Hardware', [
      environment.cpuCores ? `${environment.cpuCores} cores` : undefined,
      environment.deviceMemoryGb ? `${environment.deviceMemoryGb}GB memory` : undefined,
    ].filter(Boolean).join(', ') || undefined],
    ['In session', environment.sessionSeconds === undefined ? undefined : `${Math.floor(environment.sessionSeconds / 60)}m ${environment.sessionSeconds % 60}s`],
  ];
  const listed = rows.filter((row): row is [string, string] => Boolean(row[1]));
  if (!listed.length) return [];
  return [['**Environment.**', ...listed.map(([label, value]) => `- ${label}: ${value}`)].join('\n')];
}

/**
 * The repro bundle, as a headline a human reads and a JSON block the bot feeds
 * to `npm run repro`. Over the budget the JSON is left out rather than truncated
 * into something that will not parse: the report row still has it whole.
 */
function describeRepro(bundle: ReproBundle | undefined, reportId: string, inline = true): string[] {
  if (!bundle) return [];
  const clips = bundle.project.tracks.flatMap((track) => track.clips).length;
  const headline = [
    `**Reproduce it.** \`npm run repro -- --report ${reportId}\` seeds this exact project:`,
    `${bundle.project.format} at ${bundle.project.fps}fps, ${clips} ${clips === 1 ? 'clip' : 'clips'}`,
    `over ${bundle.project.duration.toFixed(1)}s, v${bundle.project.version},`,
    `${bundle.assets.length} ${bundle.assets.length === 1 ? 'asset' : 'assets'}.`,
    bundle.server.commit ? `Server at ${bundle.server.commit}.` : '',
    bundle.server.provider ? `Provider: ${bundle.server.provider}.` : '',
  ].filter(Boolean).join(' ');

  const json = JSON.stringify(bundle, null, 2);
  if (!inline) {
    return [`${headline}\n\n_The bundle is ${Math.round(json.length / 1024)}KB, too large for an issue body. It is stored on report ${reportId}._`];
  }
  return [`${headline}\n\n<details><summary>repro.json</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n</details>`];
}

/**
 * The issue body, inside GitHub's limit. The bundle is dropped to its summary
 * first; if the rest is somehow still too long the body is cut, because a
 * truncated report beats a 422 and no report at all.
 */
function assembleBody(parts: string[], repro: (inline: boolean) => string[]): string {
  const full = [...parts, ...repro(true)].join('\n\n');
  if (full.length <= GITHUB_BODY_LIMIT) return full;
  const trimmed = [...parts, ...repro(false)].join('\n\n');
  if (trimmed.length <= GITHUB_BODY_LIMIT) return trimmed;
  const marker = "\n\n_Truncated to fit the issue body limit._";
  return `${trimmed.slice(0, GITHUB_BODY_LIMIT - marker.length)}${marker}`;
}

/**
 * The screenshot, and what the user drew on it. The highlight target is the
 * useful half: it names the component under the box in the app's own terms.
 */
function describeScreenshot(report: TelemetryReport, stored: StoredScreenshot | undefined): string[] {
  if (!stored) return [];
  const target = report.screenshot?.highlightTarget;
  const caption = report.screenshot?.highlight
    ? `**They highlighted** ${target ? `\`${target}\`` : 'the boxed area'}.`
    : '**Screenshot** of the screen they reported from.';
  const note = '_The client replaces every frame, thumbnail, caption, chat turn and file name with a placeholder: the picture carries the interface, not the footage or the words._';
  return [stored.url
    ? `${caption}\n\n![Screenshot](${stored.url})\n\n${note}`
    : `${caption}\n\n_Not uploaded: the image is on the server at \`${stored.path}\`._\n\n${note}`];
}

/** Whatever the current screen published about itself, in the order it sent it. */
function describeContext(context: TelemetryReport['context']): string[] {
  const entries = Object.entries(context ?? {});
  if (!entries.length) return [];
  return [['**App state when it was sent.**', ...entries.map(([key, value]) => `- ${key}: ${String(value)}`)].join('\n')];
}

/**
 * Session logs, crashes, and feedback from the client. Everything is stored
 * first, so a missing `GITHUB_TOKEN` or a GitHub outage costs a report nothing —
 * it just lands in user-insights.md for a human instead of in the tracker.
 */
export class TelemetryService {
  constructor(
    private readonly store: ReportStore,
    private readonly provider: () => Promise<ToolProvider>,
    private readonly insightsPath = join(dataRoot, 'user-insights.md'),
    /** Optional so the telemetry tests, and a report with no project, still work. */
    private readonly repro?: ReproService,
  ) {}

  async ingest(report: TelemetryReport, userId?: string): Promise<TelemetryReceipt> {
    const fingerprint = report.error ? createHash('sha256').update(report.error.message).digest('hex').slice(0, 16) : undefined;
    const reportId = this.store.insert(report, userId, fingerprint);

    if (report.kind === 'session') {
      this.appendInsight(
        `## Session ${report.sessionId} · ${report.platform}`,
        [`Events: ${summarize(report.events)}`, ...describeContext(report.context), ...describeEnvironment(report.environment)],
      );
      return { reportId, issueNumber: null, issueUrl: null, note: 'Session logged for review.' };
    }

    const known = fingerprint ? this.store.findIssue(fingerprint) : undefined;
    if (known) {
      this.store.attachIssue(reportId, known);
      return { reportId, ...known, note: 'Already tracked, added to the open issue.' };
    }

    // Built from the server's own tables, so the bundle costs the report
    // nothing on the wire. The project id is client-supplied, so the lookup is
    // scoped to the reporter: an id someone else's project owns finds nothing,
    // and an unauthenticated report (a crash on the sign-in screen) gets no
    // bundle at all rather than an unscoped one.
    const projectId = typeof report.context?.projectId === 'string' ? report.context.projectId : undefined;
    const bundle = projectId && userId ? this.repro?.build(projectId, userId) : undefined;
    if (bundle) this.store.attachRepro(reportId, bundle);

    // Beside the insights file, so a test (or a second instance) keeps its own.
    const shot = report.screenshot
      ? await storeScreenshot(
        reportId,
        report.screenshot,
        GITHUB_REPO,
        join(dirname(this.insightsPath), 'report-screenshots'),
        Boolean(userId),
      )
      : undefined;

    const assessment = await this.assess(report, bundle);
    const issue = await this.file(report, assessment, bundle, reportId, shot);
    if (!issue) {
      this.appendInsight(`## ${assessment.title}`, [
        assessment.feasibility,
        ...this.details(report),
        ...describeScreenshot(report, shot),
        ...describeRepro(bundle, reportId),
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
  private async assess(report: TelemetryReport, bundle?: ReproBundle): Promise<Assessment> {
    const subject = report.error?.message ?? report.feedback ?? 'Unspecified report';
    const system = [
      'You triage bug reports and feature requests for a video-editing app.',
      'Return only one JSON object: {"title": string, "feasibility": string, "area": string}.',
      'Title is under 80 characters and names the problem or request.',
      'Feasibility is one short paragraph: the likely cause or change, and how hard it looks.',
      'Ground it in the environment and app state you are given: name the screen, the browser, and whatever the event log shows the user doing.',
      'Area is one lowercase word for the part of the app involved, such as timeline, preview, chat, import, export, or auth.',
      NO_DASHES_RULE,
    ].join(' ');
    try {
      const provider = await this.provider();
      const raw = await provider.completeText(system, JSON.stringify({
        kind: report.kind,
        platform: report.platform,
        ...(report.appVersion ? { appVersion: report.appVersion } : {}),
        ...(report.error ? { error: { message: report.error.message, ...(report.error.stack ? { stack: report.error.stack.slice(0, 2000) } : {}) } } : {}),
        ...(report.error?.componentStack ? { componentStack: report.error.componentStack.slice(0, 1000) } : {}),
        ...(report.feedback ? { feedback: report.feedback } : {}),
        ...(report.environment ? { environment: report.environment } : {}),
        ...(report.context ? { appState: report.context } : {}),
        ...(report.screenshot?.highlightTarget ? { userHighlighted: report.screenshot.highlightTarget } : {}),
        recentEvents: report.events.slice(-30),
        // The shape of the timeline, not the timeline itself: enough for the
        // model to reason about scale without spending the context on clip ids.
        ...(bundle ? {
          timeline: {
            format: bundle.project.format,
            fps: bundle.project.fps,
            duration: bundle.project.duration,
            tracks: bundle.project.tracks.map((track) => ({ kind: track.kind, clips: track.clips.length })),
          },
          recentOps: bundle.recentOps.slice(-8).map((entry) => entry.operation.type),
        } : {}),
      }));
      const parsed = JSON.parse(raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? raw.trim()) as Partial<Assessment>;
      if (typeof parsed.title === 'string' && typeof parsed.feasibility === 'string' && parsed.title.trim()) {
        return {
          title: parsed.title.slice(0, 120),
          feasibility: parsed.feasibility,
          ...(typeof parsed.area === 'string' && /^[a-z][a-z-]{1,20}$/.test(parsed.area.trim()) ? { area: parsed.area.trim() } : {}),
        };
      }
    } catch (error) {
      console.warn('[telemetry] feasibility assessment fell back to the template:', error);
    }
    return {
      title: `${report.kind === 'error' ? 'Crash' : 'Feedback'}: ${subject.split('\n')[0]?.slice(0, 90) ?? subject}`,
      feasibility: this.fallbackFeasibility(report),
    };
  }

  /**
   * What we can say without a model. The old line said only that triage was
   * manual, which left the reader with nothing; this one at least points at the
   * screen, the client, and the last thing the user did.
   */
  private fallbackFeasibility(report: TelemetryReport): string {
    const where = report.context?.screen ? `on the ${String(report.context.screen)} screen` : `on ${report.platform}`;
    const client = report.environment?.userAgent ? describeAgent(report.environment.userAgent) : report.platform;
    const last = report.events.at(-1);
    const parts = [
      `No LLM provider was reachable, so this one needs a human read.`,
      `${report.kind === 'error' ? 'A crash' : 'Feedback'} ${where}, from ${client}${report.appVersion ? ` on v${report.appVersion}` : ''}.`,
      last ? `The last thing logged was ${last.type}${last.detail ? ` (${last.detail})` : ''}.` : 'The session log was empty.',
      ...(report.screenshot?.highlightTarget ? [`They highlighted ${report.screenshot.highlightTarget}.`] : []),
      'Everything the client sent is below.',
    ];
    return parts.join(' ');
  }

  /** `null` whenever nothing reached GitHub; the caller falls back to the file. */
  private async file(
    report: TelemetryReport,
    assessment: Assessment,
    bundle: ReproBundle | undefined,
    reportId: string,
    shot: StoredScreenshot | undefined,
  ): Promise<StoredIssue | undefined> {
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
          body: assembleBody(
            [
              `**Feasibility.** ${assessment.feasibility}`,
              ...this.details(report),
              ...describeScreenshot(report, shot),
            ],
            (inline) => describeRepro(bundle, reportId, inline),
          ),
          // `area:*` is what a triager filters on, so the model's read of which
          // part of the app is involved is worth carrying onto the issue.
          labels: [
            'user-report',
            report.kind === 'error' ? 'bug' : 'enhancement',
            ...(assessment.area ? [`area:${assessment.area}`] : []),
          ],
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
      ...(report.error?.componentStack
        ? ['<details><summary><b>Component stack</b></summary>\n\n```\n' + report.error.componentStack.trim() + '\n```\n</details>']
        : []),
      ...(report.feedback ? [`**What the user said.** ${report.feedback}`] : []),
      ...describeContext(report.context),
      ...describeEnvironment(report.environment),
      ...timeline(report.events),
      `**Session.** ${report.sessionId} · ${report.platform}${report.appVersion ? ` · v${report.appVersion}` : ''} · ${summarize(report.events)}`,
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
