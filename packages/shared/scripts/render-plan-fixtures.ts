/*
 * Writes packages/shared/fixtures/render-plans/*.json FROM buildRenderPlan, so
 * the fixtures every executor golden-tests against (the Swift renderer, the
 * P6 server render) are exactly what the builder emits and cannot drift.
 *
 *   npx tsx packages/shared/scripts/render-plan-fixtures.ts          # rewrite the fixtures
 *   npx tsx packages/shared/scripts/render-plan-fixtures.ts --check  # fail if any is stale
 *
 * server/test/render-plan.test.ts runs the check. Each scenario keeps a small
 * frame (360 x 640, or 1080 x 1920 where the caption layout is the point).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRenderPlan, type Clip, type PlanAssetInfo, type PlanTarget, type Project, type RenderPlan, type Track } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(here, '../fixtures/render-plans');

/** The media every scenario draws from, as the device's media ladder would describe it. */
export const FIXTURE_ASSETS: Readonly<Record<string, PlanAssetInfo>> = {
  'asset-talk': { kind: 'video', width: 1080, height: 1920, duration: 30, hasAudio: true, fps: 30 },
  'asset-cutaway': { kind: 'video', width: 1080, height: 1920, duration: 30, hasAudio: true, fps: 30 },
  'asset-a': { kind: 'video', width: 1080, height: 1920, duration: 8, hasAudio: true, fps: 30 },
  'asset-a-short': { kind: 'video', width: 1080, height: 1920, duration: 2.2, hasAudio: true, fps: 30 },
  'asset-b': { kind: 'video', width: 1080, height: 1920, duration: 8, hasAudio: true, fps: 30 },
  'asset-hlg': { kind: 'video', width: 1080, height: 1920, duration: 10, hasAudio: true, fps: 30 },
  'asset-music': { kind: 'audio', width: 0, height: 0, duration: 60, hasAudio: true },
  'asset-voice': { kind: 'audio', width: 0, height: 0, duration: 10, hasAudio: true },
  'asset-logo': { kind: 'image', width: 500, height: 500, duration: 0, hasAudio: false },
  'asset-gif': { kind: 'image', width: 400, height: 300, duration: 2, hasAudio: false, animated: true },
  'asset-city': { kind: 'video', width: 1080, height: 1920, duration: 20, hasAudio: true, fps: 30 },
};

export interface FixtureScenario {
  name: string;
  /** What the fixture shows; may quote numbers from the built plan so it never goes stale. */
  description: (plan: RenderPlan) => string;
  project: Project;
  target: PlanTarget;
  revision: number;
  buildSeq: number;
}

const SMALL: PlanTarget = { kind: 'preview', size: { w: 360, h: 640 }, color: 'sdr' };
const FULL: PlanTarget = { kind: 'export', size: { w: 1080, h: 1920 }, color: 'sdr' };
const STYLE = { font: 'Montserrat', size: 64, color: '#FFFFFF', emphasis: 'bold' } as const;

function project(tracks: Track[], duration?: number): Project {
  const end = Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + (clip.out - clip.in) / (clip.speed ?? 1))));
  return { id: 'fixture', title: 'Fixture', format: '9:16', fps: 30, duration: duration ?? end, version: 0, tracks };
}
const video = (clips: Clip[], id = 'video'): Track => ({ id, kind: 'video', clips });
const audio = (clips: Clip[], id = 'audio'): Track => ({ id, kind: 'audio', clips });
const captions = (clips: Clip[]): Track => ({ id: 'captions', kind: 'caption', clips });
const overlay = (clips: Clip[]): Track => ({ id: 'overlay', kind: 'overlay', clips });
const talk = (seconds: number): Track => video([{ id: 'talk', assetId: 'asset-talk', start: 0, in: 0, out: seconds }]);

export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = [
  {
    name: 'audio-duck-loudness',
    description: () => 'A voiceover from 2 s to 4 s ducks everything else to 30% with 0.12 s linear ramps (the clip sound at volume 1 and a music bed at 0.5), and the master is normalized to -16 LUFS (0.5 LU deadband, silent below -60 LUFS) through a -1.5 dB limiter ceiling, with -1 dBTP as the true-peak acceptance limit.',
    project: project([
      talk(6),
      audio([{ id: 'bed', assetId: 'asset-music', start: 0, in: 0, out: 6, volume: 0.5 }], 'music'),
      audio([{ id: 'vo', assetId: 'asset-voice', start: 2, in: 0, out: 2, duck: true }], 'voice'),
    ]),
    target: SMALL,
    revision: 14,
    buildSeq: 1,
  },
  {
    name: 'caption-karaoke',
    description: (plan) => `A ${plan.captions[0]!.lines.length}-line karaoke caption: words light in the emphasis colour at their absolute timeline start (document words were relative to words[0].s = 10.2 at clip.start 0.5), each word at its own pen x.`,
    project: project([talk(3), captions([{
      id: 'cap-k', start: 0.5, in: 0, out: 2.4, text: 'HOW ARE YOU DOING TODAY',
      style: {
        ...STYLE, size: 140, position: 'bottom', words: [
          { w: 'HOW', s: 10.2, e: 10.5 }, { w: 'ARE', s: 10.5, e: 10.8 }, { w: 'YOU', s: 10.8, e: 11.1 },
          { w: 'DOING', s: 11.2, e: 11.6 }, { w: 'TODAY', s: 11.7, e: 12.3 },
        ],
      },
    }])]),
    target: FULL,
    revision: 10,
    buildSeq: 1,
  },
  {
    name: 'caption-shrunk',
    description: (plan) => {
      const caption = plan.captions[0]!;
      return `A caption too long for three lines at its styled size: the layout shrank it by ${caption.fitted.scale} to ${caption.sizePx} px over ${caption.lines.length} lines and flagged it, with no ellipsis.`;
    },
    project: project([talk(3), captions([{
      id: 'cap-long', start: 0, in: 0, out: 3, text: 'NOBODY TELLS YOU THIS ABOUT RUNNING A MARATHON IN THE POURING RAIN',
      style: { ...STYLE, size: 130, position: 'bottom' },
    }])]),
    target: SMALL,
    revision: 11,
    buildSeq: 1,
  },
  {
    name: 'captions-multi-lane',
    description: () => 'Two caption lanes on screen at once: a bottom lane with two captions, the first trimmed to end where the second starts, and a top lane caption overlapping both.',
    project: project([talk(3), captions([
      { id: 'cap-1', start: 0, in: 0, out: 2, text: 'FIRST LINE', style: { ...STYLE, position: 'bottom' } },
      { id: 'cap-2', start: 1.5, in: 0, out: 1.5, text: 'SECOND LINE', style: { ...STYLE, position: 'bottom' } },
      { id: 'cap-top', start: 0.5, in: 0, out: 2, text: 'TOP TEXT', style: { ...STYLE, position: 'top' } },
    ])]),
    target: FULL,
    revision: 9,
    buildSeq: 1,
  },
  {
    name: 'crossfade-hold',
    description: () => 'A 0.6 s crossfade where clip a has only 0.2 s of source past its out point: it plays that handle, then holds its last frame for the remaining 0.4 s under clip b; audio crossfades only over the real 0.2 s.',
    project: project([video([
      { id: 'a', assetId: 'asset-a-short', start: 0, in: 0, out: 2 },
      { id: 'b', assetId: 'asset-b', start: 2, in: 0, out: 2, transition: { type: 'crossfade', duration: 0.6 } },
    ])]),
    target: SMALL,
    revision: 5,
    buildSeq: 1,
  },
  {
    name: 'crossfade',
    description: () => 'A 0.5 s crossfade into clip b at 2 s: clip a borrows 0.5 s of source past its out point under b, which fades in from opacity 0; the audio swaps edge fades for linear tri-fades.',
    project: project([video([
      { id: 'a', assetId: 'asset-a', start: 0, in: 0, out: 2 },
      { id: 'b', assetId: 'asset-b', start: 2, in: 1, out: 3, transition: { type: 'crossfade', duration: 0.5 } },
    ])]),
    target: SMALL,
    revision: 3,
    buildSeq: 1,
  },
  {
    name: 'dip',
    description: () => 'A 0.6 s dip to black at 2 s: clip a dims to black over its last 0.3 s and clip b rises from black over its first 0.3 s, both staying opaque; audio fades linearly on the same windows.',
    project: project([video([
      { id: 'a', assetId: 'asset-a', start: 0, in: 0, out: 2 },
      { id: 'b', assetId: 'asset-b', start: 2, in: 0, out: 2, transition: { type: 'dip', duration: 0.6 } },
    ])]),
    target: SMALL,
    revision: 4,
    buildSeq: 1,
  },
  {
    name: 'empty-project',
    description: () => 'A project with no clips: duration 0, nothing to draw or play.',
    project: project([video([]), captions([])], 0),
    target: SMALL,
    revision: 0,
    buildSeq: 1,
  },
  {
    name: 'hlg-color',
    description: () => 'An HLG master: one HDR clip composited in linear BT.2020 with a white caption placed at the 203-nit reference white, encoded HLG 10-bit.',
    project: project([
      video([{ id: 'sunset', assetId: 'asset-hlg', start: 0, in: 0, out: 2 }]),
      captions([{ id: 'cap-hdr', start: 0, in: 0, out: 2, text: 'GOLDEN HOUR', style: { ...STYLE, position: 'bottom' } }]),
    ]),
    target: { ...SMALL, color: 'hlg' },
    revision: 13,
    buildSeq: 1,
  },
  {
    name: 'overlapping-video-tracks',
    description: () => 'Two video tracks overlap from 1 s to 2 s: the cutaway on track 1 stacks above the main clip (z 1 over z 0), and both keep their sound.',
    project: project([
      video([{ id: 'main', assetId: 'asset-talk', start: 0, in: 0, out: 3 }], 'v0'),
      video([{ id: 'cutaway', assetId: 'asset-cutaway', start: 1, in: 4, out: 5 }], 'v1'),
    ]),
    target: SMALL,
    revision: 12,
    buildSeq: 1,
  },
  {
    name: 'overlays',
    description: (plan) => {
      const fire = plan.overlays.find((item) => item.kind === 'emoji')!.emoji!;
      return `Every overlay kind over one video layer, each rotated except the logo: image sticker, looping GIF, emoji fitted to its box (Apple Color Emoji advance 1.0 em, ascent 1.0 em, descent 0.3125 em: ${fire.sizePx} px, baseline ${fire.y}), a check callout resolved to card, vector glyph and label, and a picture-in-picture b-roll clip trimmed from its source, stacked by z.`;
    },
    project: project([talk(4), overlay([
      { id: 'sticker-logo', assetId: 'asset-logo', start: 0, in: 0, out: 4, overlay: { x: 0.25, y: 0.1875, width: 100 / 360, rotation: 0 } },
      { id: 'sticker-gif', assetId: 'asset-gif', start: 0.5, in: 0, out: 3, overlay: { x: 0.75, y: 0.21875, width: 1 / 3, rotation: -12 } },
      { id: 'emoji-fire', start: 1, in: 0, out: 2, text: '🔥', overlay: { x: 0.5, y: 300 / 640, width: 100 / 360, rotation: 15 } },
      { id: 'callout-check', start: 1.5, in: 0, out: 2.5, text: 'Do this', callout: { variant: 'check' }, overlay: { x: 0.5, y: 0.75, width: 260 / 360, rotation: -4 } },
      { id: 'broll-city', assetId: 'asset-city', start: 2, in: 3, out: 4.5, overlay: { x: 250 / 360, y: 0.3125, width: 0.5, rotation: 6 } },
    ])]),
    target: SMALL,
    revision: 8,
    buildSeq: 1,
  },
  {
    name: 'speed-2x',
    description: () => 'A clip at 2x speed: source 1 s to 5 s plays over timeline 0 s to 2 s, picture and pitch-preserved audio both.',
    project: project([video([{ id: 'fast', assetId: 'asset-talk', start: 0, in: 1, out: 5, speed: 2 }])]),
    target: SMALL,
    revision: 7,
    buildSeq: 1,
  },
  {
    name: 'zoom',
    description: () => 'A punch-in from transform {scale 1} to transformEnd {scale 1.15, y -0.2} across a 3 s clip whose source matches the 9:16 frame, so two crop keys reproduce the move exactly.',
    project: project([video([{
      id: 'talk', assetId: 'asset-talk', start: 0, in: 0, out: 3,
      transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.15, x: 0, y: -0.2 },
    }])]),
    target: SMALL,
    revision: 6,
    buildSeq: 1,
  },
];

export function buildFixture(scenario: FixtureScenario): { description: string; plan: RenderPlan } {
  const plan = buildRenderPlan(scenario.project, scenario.target, {
    revision: scenario.revision,
    buildSeq: scenario.buildSeq,
    assetInfo: (id) => FIXTURE_ASSETS[id],
  });
  return { description: scenario.description(plan), plan };
}

export function fixtureText(scenario: FixtureScenario): string {
  return `${JSON.stringify(buildFixture(scenario), null, 2)}\n`;
}

/** Fixture files that differ from what the builder writes now, plus files no scenario writes. */
export function staleFixtures(): string[] {
  const stale = FIXTURE_SCENARIOS
    .filter((scenario) => {
      try {
        return readFileSync(join(FIXTURES_DIR, `${scenario.name}.json`), 'utf8') !== fixtureText(scenario);
      } catch {
        return true;
      }
    })
    .map((scenario) => `${scenario.name}.json`);
  const known = new Set(FIXTURE_SCENARIOS.map((scenario) => `${scenario.name}.json`));
  return [...stale, ...readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.json') && !known.has(name))];
}

function main(): void {
  if (process.argv.includes('--check')) {
    const stale = staleFixtures();
    if (stale.length > 0) {
      console.error(`stale render-plan fixtures: ${stale.join(', ')}; run npx tsx packages/shared/scripts/render-plan-fixtures.ts`);
      process.exit(1);
    }
    return;
  }
  for (const scenario of FIXTURE_SCENARIOS) writeFileSync(join(FIXTURES_DIR, `${scenario.name}.json`), fixtureText(scenario));
  console.log(`wrote ${FIXTURE_SCENARIOS.length} fixtures`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
