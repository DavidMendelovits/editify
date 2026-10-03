/**
 * Capability-lab S5 fixtures: the .ass files the phone's libass will render,
 * plus the frames the server's libass (ffmpeg `subtitles=`) draws from the same
 * file, as the visual reference. Throwaway: generateAss moves to
 * packages/shared in M3 and this script goes away (plan decision 4B).
 *
 *   npx tsx scripts/dump-ass.ts                       # built-in fixture projects
 *   npx tsx scripts/dump-ass.ts project.json ...      # plus real projects (GET /projects/:id JSON)
 *
 * Output: server/data/lab-ass/<name>-<w>x<h>.ass and <name>-<w>x<h>-<t>s.png
 * (gitignored). The phone needs the .ass files and the Montserrat font next to them.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSchema, type Clip, type Project } from '@editify/shared';
import { generateAss, locateAssFont } from '../src/media/ass.js';

const serverRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const outRoot = join(serverRoot, 'data', 'lab-ass');
/** Preview size and the 4K export size S5 measures. */
const SIZES = [[1080, 1920], [2160, 3840]] as const;

function caption(id: string, start: number, text: string, style: Clip['style']): Clip {
  return { id, start, in: 0, out: 3, text, style };
}

function fixture(id: string, clips: Clip[]): Project {
  return projectSchema.parse({ id, title: id, format: '9:16', fps: 30, duration: 6, version: 0, tracks: [{ id: 'captions', kind: 'caption', clips }] });
}

const words = (text: string, start = 0, each = 0.4) =>
  text.split(' ').map((w, i) => ({ w, s: start + i * each, e: start + (i + 1) * each }));

/** Each fixture exercises a different part of ass.ts: karaoke timing, anchoring, stroke, wrapping. */
const FIXTURES: Project[] = [
  fixture('karaoke-bottom', [
    caption('k1', 0, 'this is the part nobody tells you', { font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'bottom', emphasis: 'bold', emphasisColor: '#FACC15', strokePx: 4, words: words('this is the part nobody tells you') }),
  ]),
  fixture('anchored-center', [
    caption('a1', 0, 'Anchored at forty percent', { font: 'Montserrat', size: 72, color: '#39D98A', position: 'center', emphasis: 'bold', anchorPct: 40, strokeColor: '#14141B', strokePx: 6 }),
  ]),
  fixture('long-wrap-top', [
    caption('w1', 0, 'A deliberately long caption line that has to wrap across more than one row on a phone', { font: 'Montserrat', size: 56, color: '#FFFFFF', position: 'top', emphasis: 'none' }),
  ]),
];

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${command} exited ${code}: ${stderr.slice(-400)}`))));
  });
}

async function main(): Promise<void> {
  const extra = await Promise.all(process.argv.slice(2).map(async (path) => projectSchema.parse(JSON.parse(await readFile(path, 'utf8')))));
  const font = locateAssFont();
  await mkdir(outRoot, { recursive: true });
  if (font.directory) await copyFile(join(font.directory, 'Montserrat-Bold.ttf'), join(outRoot, 'Montserrat-Bold.ttf')).catch(() => undefined);

  for (const project of [...FIXTURES, ...extra]) {
    const name = basename(project.id);
    for (const [width, height] of SIZES) {
      const stem = `${name}-${width}x${height}`;
      const assPath = join(outRoot, `${stem}.ass`);
      await writeFile(assPath, generateAss(project, width, height, { fontFamily: font.family }), 'utf8');
      // Reference frames: mid-karaoke and late, over black, from the same libass the export uses.
      for (const t of [0.9, 2.5]) {
        const fontsDir = font.directory ? `:fontsdir='${font.directory}'` : '';
        await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=black:s=${width}x${height}:d=3:r=30`,
          '-vf', `subtitles='${assPath}'${fontsDir}`, '-ss', String(t), '-frames:v', '1', join(outRoot, `${stem}-${t}s.png`)]);
      }
    }
    console.log(`wrote ${name}`);
  }
  console.log(`fixtures in ${outRoot} (font: ${font.family})`);
}

await main();
