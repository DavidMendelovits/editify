import { rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { rendersRoot } from '../config.js';

/**
 * Everything a render left on disk: its directory under rendersRoot (the
 * output, legacy captions.ass, the plan render's work files, the contact
 * sheet), and the output file itself if it lives anywhere else. A directory
 * is only removed when it is one render's own folder inside rendersRoot.
 */
export async function removeRenderFiles(renders: ReadonlyArray<{ id: string; outputPath?: string | null }>): Promise<void> {
  const root = resolve(rendersRoot);
  const own = (path: string): boolean => {
    const inside = relative(root, resolve(path));
    return inside !== '' && !inside.startsWith('..') && !inside.includes(sep);
  };
  await Promise.all(renders.flatMap((render) => {
    const jobs: Array<Promise<void>> = [];
    const folder = join(root, render.id);
    if (own(folder)) jobs.push(rm(folder, { recursive: true, force: true }));
    if (render.outputPath) {
      const parent = dirname(resolve(render.outputPath));
      if (own(parent)) jobs.push(rm(parent, { recursive: true, force: true }));
      else jobs.push(rm(render.outputPath, { force: true }));
    }
    return jobs;
  }));
}
