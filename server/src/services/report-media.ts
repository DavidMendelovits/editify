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

function decode(screenshot: TelemetryScreenshot): { bytes: Buffer; extension: string } | undefined {
  const match = /^data:image\/(jpeg|png);base64,(.+)$/s.exec(screenshot.data);
  if (!match?.[1] || !match[2]) return undefined;
  return { bytes: Buffer.from(match[2], 'base64'), extension: match[1] === 'png' ? 'png' : 'jpg' };
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
  if (!token) return { path };

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
