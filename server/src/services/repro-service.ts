import { execFileSync, } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Operation, Project } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import type { ChatStore } from '../db/chat-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { SettingsStore } from '../db/settings-store.js';
import { PROVIDER_SETTING_KEY } from '../agent/registry.js';

/** Ops and chat turns are trails, not archives: only the recent end is useful. */
const RECENT_OPS = 20;
const RECENT_CHAT = 6;

/**
 * The bundle leaves the building: it is pasted onto a GitHub issue where the
 * user never sees it, unlike the screenshot they preview before attaching. So
 * it carries structure and never content. Durations, dimensions, track shapes
 * and operation types reproduce the bug; a filename, a project title and a
 * chat message are the user's own words about their own footage, and none of
 * them are needed to rebuild a timeline. The unredacted rows stay in the
 * server's database for anyone who genuinely needs them.
 */
function anonymize(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Caption text is transcribed speech: the words someone said on camera. It is
 * masked rather than dropped, keeping word count and word lengths, because
 * half the caption bugs worth reproducing are about how a long line wraps or
 * overflows and that behaviour has to survive the redaction.
 */
function maskText(text: string): string {
  return text.replace(/\S/g, 'x');
}

/**
 * Keys anywhere in an operation whose value is something a person wrote: a
 * caption line, a project title, an asset label. The operation log is the same
 * content the document holds, one edit at a time, so it needs the same mask.
 */
const AUTHORED_KEYS = new Set(['text', 'title', 'label', 'name']);
/**
 * Karaoke timing carries the transcript one word at a time under `w`, which is
 * the same spoken content as the caption line and needs the same mask. The
 * timings themselves stay: a word landing at the wrong moment is a real bug.
 */
const AUTHORED_WORD_KEY = 'w';

function maskAuthored<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => maskAuthored(entry)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      (AUTHORED_KEYS.has(key) || key === AUTHORED_WORD_KEY) && typeof entry === 'string'
        ? maskText(entry)
        : maskAuthored(entry),
    ])) as T;
  }
  return value;
}

/** `IMG_2231.mov` becomes `clip-9f2a1c04.mov`: same media shape, no name. */
export function anonymizeName(originalName: string): string {
  const extension = /\.[a-z0-9]{1,5}$/i.exec(originalName)?.[0] ?? '';
  return `clip-${anonymize(originalName)}${extension.toLowerCase()}`;
}

/**
 * Everything needed to rebuild the state a report was sent from, minus the
 * media bytes. `scripts/repro.ts` turns one of these back into a real project.
 */
export interface ReproBundle {
  capturedAt: string;
  /** The exact document at report time. Seeding this is the whole point. */
  project: Project;
  /** Probe data only, so a repro can substitute footage of the same shape. */
  assets: Array<{
    id: string;
    /** A stable stand-in for the filename, not the filename. */
    originalName: string;
    mimeType: string;
    duration: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
    status: string;
    label?: string;
  }>;
  /** How the project got here: the newest edits, oldest first. */
  recentOps: Array<{ at: string; batchId: string; operation: Operation; fromVersion: number; toVersion: number; undone: boolean }>;
  /**
   * The agent's side of it, when the state came out of a conversation. The
   * prose is not carried: what reproduces an agent-caused state is which turn
   * produced how many operations, not what the user typed about their footage.
   */
  chat: Array<{ role: string; at: string; characters: number; opCount: number }>;
  server: { provider?: string; commit?: string; node: string; platform: string };
}

function gitCommit(): string | undefined {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Not a checkout (a container image, say). The rest of the bundle stands.
    return undefined;
  }
}

/** A local asset the bundle's media could be replaced with. */
export interface SubstitutableAsset { id: string; originalName: string; duration: number; width: number; height: number }

/**
 * The closest local stand-in for an asset a bundle describes: the same media
 * when this is the machine the report came from, otherwise the nearest duration
 * at a matching orientation, so a 9:16 clip is never replaced by a landscape one.
 */
export function chooseSubstitute<T extends SubstitutableAsset>(wanted: ReproBundle['assets'][number], pool: T[]): T | undefined {
  // The bundle carries anonymized names, so a local file is matched by running
  // it through the same hash rather than by comparing the names directly.
  const exact = pool.find((asset) => asset.id === wanted.id)
    ?? pool.find((asset) => anonymizeName(asset.originalName) === wanted.originalName);
  if (exact) return exact;
  const portrait = wanted.height >= wanted.width;
  const sameShape = pool.filter((asset) => (asset.height >= asset.width) === portrait);
  const candidates = sameShape.length ? sameShape : pool;
  // Long enough to hold the clip's out point wins; otherwise take the nearest.
  const enough = candidates.filter((asset) => asset.duration >= wanted.duration);
  return (enough.length ? enough : candidates)
    .slice()
    .sort((left, right) => Math.abs(left.duration - wanted.duration) - Math.abs(right.duration - wanted.duration))[0];
}

/**
 * Builds the repro bundle for a project a report came from. Everything it reads
 * is already in the database, so a report costs nothing extra on the client and
 * an older client still produces a full bundle.
 */
export class ReproService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly assets: AssetStore,
    private readonly chat: ChatStore,
    private readonly settings: SettingsStore,
  ) {}

  build(projectId: string, userId: string): ReproBundle | undefined {
    // Scoped: the project id arrives from the client, so it is a request, not a
    // permission. A project belonging to someone else resolves to nothing.
    const stored = this.projects.get(projectId, userId);
    if (!stored) return undefined;
    // The timeline in full: every position, duration, transform and style, with
    // everything the user wrote themselves (the title, the caption lines, the
    // per-word karaoke timings) masked down to its shape. The mask runs first
    // and the title is set after, or the deep mask would eat the hash too.
    const project = { ...maskAuthored(stored), title: `Project ${anonymize(stored.title)}` };

    const referenced = new Set(project.tracks.flatMap((track) => track.clips).flatMap((clip) => (clip.assetId ? [clip.assetId] : [])));
    const assets = [...referenced]
      .map((id) => this.assets.get(id))
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
      .map((asset) => ({
        id: asset.id,
        originalName: anonymizeName(asset.originalName),
        mimeType: asset.mimeType,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        fps: asset.fps,
        hasAudio: asset.hasAudio,
        status: asset.status,
        // A label is typed by the user ("uncle dave laughing"), so it travels
        // as a marker that one exists rather than as its text.
        ...(asset.label ? { label: `labelled-${anonymize(asset.label)}` } : {}),
      }));

    const recentOps = this.projects.operationLog(projectId).slice(-RECENT_OPS).map((entry) => ({
      at: entry.createdAt,
      batchId: entry.batchId,
      operation: maskAuthored(entry.operation),
      fromVersion: entry.beforeVersion,
      toVersion: entry.afterVersion,
      undone: entry.undone,
    }));

    const chat = this.chat.list(projectId).slice(-RECENT_CHAT).map((message) => ({
      role: message.role,
      at: message.createdAt,
      characters: message.content.length,
      opCount: message.ops?.length ?? 0,
    }));

    const provider = this.settings.get(PROVIDER_SETTING_KEY);
    const commit = gitCommit();
    return {
      capturedAt: new Date().toISOString(),
      project,
      assets,
      recentOps,
      chat,
      server: {
        ...(provider ? { provider } : {}),
        ...(commit ? { commit } : {}),
        node: process.version,
        platform: process.platform,
      },
    };
  }
}
