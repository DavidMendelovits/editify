import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '@editify/shared';
import { generateAss, locateAssFont } from '../src/media/ass.js';
import { runProcess } from '../src/media/process.js';

describe('caption font', () => {
  // Regression: the bundled file was the variable Montserrat, and libass
  // answered `fontselect: (Montserrat, 700, 0) -> Helvetica-Bold`, so every
  // captioned export silently shipped in Helvetica.
  it('libass resolves bold Montserrat from the bundled font, not a system fallback', async () => {
    const font = locateAssFont();
    expect(font).toMatchObject({ family: 'Montserrat' });
    const project: Project = {
      id: 'font', title: 'Font', format: '9:16', fps: 30, duration: 1, version: 0,
      tracks: [{ id: 'captions', kind: 'caption', clips: [
        { id: 'c', start: 0, in: 0, out: 1, text: 'LAUGH', style: { font: 'Montserrat', size: 64, color: '#FFFFFF', position: 'bottom', emphasis: 'bold' } },
      ] }],
    };
    const dir = await mkdtemp(join(tmpdir(), 'editify-font-'));
    try {
      const assPath = join(dir, 'captions.ass');
      await writeFile(assPath, generateAss(project, 1080, 1920, { fontFamily: font.family }));
      const { stderr } = await runProcess('ffmpeg', [
        '-v', 'verbose', '-f', 'lavfi', '-i', 'color=black:s=1080x1920:d=0.5',
        '-vf', `subtitles='${assPath}':fontsdir='${font.directory}'`, '-frames:v', '1', '-f', 'null', '-',
      ]);
      expect(stderr).toMatch(/fontselect: \(Montserrat, 700, 0\) -> .*Montserrat-Bold/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
