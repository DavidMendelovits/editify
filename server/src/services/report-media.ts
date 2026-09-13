import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetryScreenshot } from '@editify/shared';

/**
 * Where a report's screenshot goes. GitHub has no API for the attachment
 * uploader its web UI uses, so the image is committed to a media branch instead
 * and linked with `?raw=true`: that URL renders inline on the issue and, on a
 * private repo, resolves against the reader's own access rather than a token in
 * a URL. A copy is always written to disk first, so a failed push never loses
 * the picture.
 */
const MEDIA_BRANCH = 'report-media';

export interface StoredScreenshot {
  /** Absolute path of the local copy, always present. */
  path: string;
  /** Embeddable URL, when the push succeeded. */
  url?: string;
}

interface GitHubTarget { repo: string; token: string }

/**
 * The declared media type is just a string the client sent. These bytes are
 * written to disk and committed to a repository, so the file has to actually be
 * the image it claims: base64 decodes anything, and `data:image/png;base64,`
 * in front of an archive or a binary is free to write.
 */
const MAGIC: Record<'png' | 'jpg', number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
};

function decode(screenshot: TelemetryScreenshot): { bytes: Buffer; extension: 'png' | 'jpg' } | undefined {
  const match = /^data:image\/(jpeg|png);base64,(.+)$/s.exec(screenshot.data);
  if (!match?.[1] || !match[2]) return undefined;
  const extension = match[1] === 'png' ? 'png' : 'jpg';
  const bytes = Buffer.from(match[2], 'base64');
  const magic = MAGIC[extension];
  if (bytes.length < magic.length || magic.some((byte, index) => bytes[index] !== byte)) return undefined;
  return { bytes, extension };
}

async function github(target: GitHubTarget, path: string, init: RequestInit): Promise<Response> {
  return await fetch(`https://api.github.com/repos/${target.repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

/** Creates the media branch off the default branch the first time it is needed. */
async function ensureBranch(target: GitHubTarget): Promise<void> {
  const existing = await github(target, `/git/ref/heads/${MEDIA_BRANCH}`, { method: 'GET' });
  if (existing.ok) return;

  const repo = await github(target, '', { method: 'GET' });
  if (!repo.ok) throw new Error(`could not read the repository: ${repo.status}`);
  const defaultBranch = (await repo.json() as { default_branch: string }).default_branch;

  const head = await github(target, `/git/ref/heads/${defaultBranch}`, { method: 'GET' });
  if (!head.ok) throw new Error(`could not read ${defaultBranch}: ${head.status}`);
  const sha = (await head.json() as { object: { sha: string } }).object.sha;

  const created = await github(target, '/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${MEDIA_BRANCH}`, sha }),
  });
  // 422 is the race where a concurrent report created it first, which is fine.
  if (!created.ok && created.status !== 422) throw new Error(`could not create ${MEDIA_BRANCH}: ${created.status}`);
}

/**
 * Saves the screenshot beside the data directory and, when a token is
 * available, pushes it to the media branch so the issue can show it.
 */
export async function storeScreenshot(
  reportId: string,
  screenshot: TelemetryScreenshot,
  repo: string,
  directory: string,
  /**
   * Only a signed-in reporter's screenshot is pushed. POST /telemetry accepts
   * anonymous reports so a crash on the sign-in screen can still file, and
   * pushing their images would hand anyone who can reach the endpoint a
   * commit into the repository under our own token. An anonymous screenshot is
   * still kept on disk, and the issue says where.
   */
  pushable: boolean,
): Promise<StoredScreenshot | undefined> {
  const decoded = decode(screenshot);
  if (!decoded) return undefined;

  const path = join(directory, `${reportId}.${decoded.extension}`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, decoded.bytes);
  } catch (error) {
    console.warn('[telemetry] could not write the screenshot to disk:', error);
    return undefined;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token || !pushable) return { path };

  const target = { repo, token };
  const remotePath = `reports/${reportId}.${decoded.extension}`;
  try {
    await ensureBranch(target);
    const put = await github(target, `/contents/${remotePath}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Screenshot for report ${reportId}`,
        content: decoded.bytes.toString('base64'),
        branch: MEDIA_BRANCH,
      }),
    });
    if (!put.ok) throw new Error(`GitHub answered ${put.status}: ${await put.text()}`);
    return { path, url: `https://github.com/${repo}/blob/${MEDIA_BRANCH}/${remotePath}?raw=true` };
  } catch (error) {
    console.warn('[telemetry] could not push the screenshot to GitHub:', error);
    return { path };
  }
}
