import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Render directories live under the data dir: point it at a scratch folder before config loads.
const scratch = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/editify-render-files-${process.pid}`;
  process.env.EDITIFY_DATA_DIR = dir;
  return dir;
});

const { createDatabase } = await import('../src/db/database.js');
const { ProjectStore } = await import('../src/db/project-store.js');
const { RenderStore } = await import('../src/db/render-store.js');
const { deleteUserData } = await import('../src/services/account-service.js');
const { removeRenderFiles } = await import('../src/media/render-files.js');
const { rendersRoot } = await import('../src/config.js');

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A render folder the way the renderers leave it: output, legacy captions, plan work files. */
function renderFolder(id: string): string {
  const folder = join(rendersRoot, id);
  mkdirSync(join(folder, 'plan'), { recursive: true });
  writeFileSync(join(folder, 'output.mp4'), 'mp4');
  writeFileSync(join(folder, 'captions.ass'), 'ass');
  writeFileSync(join(folder, 'contact.jpg'), 'jpg');
  writeFileSync(join(folder, 'plan', 'mix.wav'), 'wav');
  return folder;
}

describe('render files on delete', () => {
  it('account deletion removes each render directory, finished or failed', async () => {
    const database = createDatabase(':memory:');
    const projects = new ProjectStore(database);
    const renders = new RenderStore(database);
    const project = projects.create({ title: 'mine', format: '9:16', fps: 30 }, 'files-alice');
    const other = projects.create({ title: 'theirs', format: '9:16', fps: 30 }, 'files-bob');
    const done = renders.create(project.id, '720p');
    const failed = renders.create(project.id, '720p');
    const kept = renders.create(other.id, '720p');
    const doneFolder = renderFolder(done.id);
    const failedFolder = renderFolder(failed.id);
    const keptFolder = renderFolder(kept.id);
    renders.update(done.id, 'done', { outputPath: join(doneFolder, 'output.mp4') });
    renders.update(failed.id, 'error', { error: 'ffmpeg exited' });

    await deleteUserData(database, 'files-alice');
    expect(existsSync(doneFolder)).toBe(false);
    expect(existsSync(failedFolder)).toBe(false);
    expect(existsSync(keptFolder)).toBe(true);
    database.close();
  });

  it('project deletion removes its render directories', async () => {
    const database = createDatabase(':memory:');
    const projects = new ProjectStore(database);
    const renders = new RenderStore(database);
    const project = projects.create({ title: 'gone', format: '9:16', fps: 30 });
    const render = renders.create(project.id, '1080p');
    const folder = renderFolder(render.id);
    renders.update(render.id, 'done', { outputPath: join(folder, 'output.mp4') });
    expect(await projects.delete(project.id)).toBe(true);
    expect(existsSync(folder)).toBe(false);
    database.close();
  });

  it('removes only an output file that lives outside rendersRoot, never its folder', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'editify-render-elsewhere-'));
    const output = join(elsewhere, 'output.mp4');
    writeFileSync(output, 'mp4');
    writeFileSync(join(elsewhere, 'keep.txt'), 'keep');
    await removeRenderFiles([{ id: '../escape', outputPath: output }]);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(join(elsewhere, 'keep.txt'))).toBe(true);
    expect(existsSync(rendersRoot)).toBe(true);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
