import { execFileSync } from 'node:child_process';
import type { Operation, Project } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import type { ChatStore } from '../db/chat-store.js';
import type { ProjectStore } from '../db/project-store.js';
import type { SettingsStore } from '../db/settings-store.js';
import { PROVIDER_SETTING_KEY } from '../agent/registry.js';

/** Ops and chat turns are trails, not archives: only the recent end is useful. */
const RECENT_OPS = 20;
const RECENT_CHAT = 6;
const CHAT_EXCERPT = 400;

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
  /** The agent's side of it, when the state came out of a conversation. */
  chat: Array<{ role: string; at: string; text: string; opCount: number }>;
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
  const exact = pool.find((asset) => asset.id === wanted.id) ?? pool.find((asset) => asset.originalName === wanted.originalName);
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

  build(projectId: string): ReproBundle | undefined {
    const project = this.projects.get(projectId);
    if (!project) return undefined;

    const referenced = new Set(project.tracks.flatMap((track) => track.clips).flatMap((clip) => (clip.assetId ? [clip.assetId] : [])));
    const assets = [...referenced]
      .map((id) => this.assets.get(id))
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
      .map((asset) => ({
        id: asset.id,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        fps: asset.fps,
        hasAudio: asset.hasAudio,
        status: asset.status,
        ...(asset.label ? { label: asset.label } : {}),
      }));

    const recentOps = this.projects.operationLog(projectId).slice(-RECENT_OPS).map((entry) => ({
      at: entry.createdAt,
      batchId: entry.batchId,
      operation: entry.operation,
      fromVersion: entry.beforeVersion,
      toVersion: entry.afterVersion,
      undone: entry.undone,
    }));

    const chat = this.chat.list(projectId).slice(-RECENT_CHAT).map((message) => ({
      role: message.role,
      at: message.createdAt,
      text: message.content.slice(0, CHAT_EXCERPT),
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
