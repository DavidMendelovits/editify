import { describe, expect, it } from 'vitest';
import type { Clip, Project } from '@editify/shared';
import type { EnergyAnalysis } from '../src/db/transcript-store.js';
import { checkMix, soundCategory } from '../src/services/mix-check.js';

/** Constant-level 50ms RMS cells. */
function flat(db: number, seconds: number): EnergyAnalysis {
  return { cellSeconds: 0.05, rmsDb: Array.from({ length: Math.round(seconds / 0.05) }, () => db) };
}

// Speech mostly at -20 dB with louder stressed syllables at -18: the 95th percentile is -18.
const voice: EnergyAnalysis = {
  cellSeconds: 0.05,
  rmsDb: Array.from({ length: 1200 }, (_unused, index) => (index % 10 === 0 ? -18 : index % 7 === 0 ? -60 : -20)),
};
const energy: Record<string, EnergyAnalysis> = {
  voice,
  'sound-impact-boom': flat(-6, 1),
  'sound-whoosh-soft': flat(-10, 0.8),
  'sound-ui-click': flat(-30, 0.1),
  'sound-music-dream': flat(-20, 30),
};

function project(audio: Clip[], duration = 60): Project {
  return {
    id: 'p', title: 'Mix', format: '9:16', fps: 30, duration, version: 0,
    tracks: [
      { id: 'video-main', kind: 'video', clips: [{ id: 'talk', assetId: 'voice', start: 0, in: 0, out: 60 }] },
      { id: 'audio-main', kind: 'audio', clips: audio },
    ],
  };
}

function sfx(id: string, assetId: string, start: number, out: number, volume?: number): Clip {
  return { id, assetId, start, in: 0, out, ...(volume === undefined ? {} : { volume }) };
}

describe('mix check', () => {
  it('judges each hit against the measured voice and suggests the volume that lands it', () => {
    const report = checkMix(project([
      sfx('boom', 'sound-impact-boom', 5, 1),
      sfx('swish', 'sound-whoosh-soft', 10, 0.8, 0.5),
      sfx('click', 'sound-ui-click', 20, 0.1),
    ]), (id) => energy[id]);
    expect(report.voiceReferenceDb).toBe(-18);
    expect(report.hits.map((hit) => [hit.clipId, hit.category, hit.levelDb, hit.verdict, hit.suggestedVolume])).toEqual([
      // -6 dB against a -18 voice is 12 dB over the voice; -8 dB wants volume 0.1.
      ['boom', 'impact', 12, 'loud', 0.1],
      ['swish', 'whoosh', 2, 'loud', 0.1],
      ['click', 'ui', -12, 'ok', undefined],
    ]);
    expect(report.warnings.some((line) => line.startsWith('boom at 5.0s (impact) is louder than the voice'))).toBe(true);
  });

  it('holds a music bed about 20 dB under the voice', () => {
    const loud = checkMix(project([sfx('bed', 'sound-music-dream', 0, 30, 0.5)]), (id) => energy[id]);
    expect(loud.beds[0]).toMatchObject({ clipId: 'bed', verdict: 'loud', suggestedVolume: 0.1 });
    const right = checkMix(project([sfx('bed', 'sound-music-dream', 0, 30, 0.1)]), (id) => energy[id]);
    expect(right.beds[0]?.verdict).toBe('ok');
  });

  it('counts layered hits once and warns past 14 structural hits a minute', () => {
    const busy = Array.from({ length: 20 }, (_unused, index) => sfx(`hit-${index}`, 'sound-impact-boom', index * 3, 1, 0.1));
    const layered = busy.map((clip) => ({ ...clip, id: `${clip.id}-whoosh`, assetId: 'sound-whoosh-soft', start: clip.start + 0.05, out: 0.8 }));
    const report = checkMix(project([...busy, ...layered]), (id) => energy[id]);
    expect(report.hitsPerMinute).toBe(20);
    expect(report.warnings.some((line) => line.includes('20 whoosh/impact hits per minute'))).toBe(true);
  });

  it('reads library ids for the category and treats long unknown audio as a bed', () => {
    expect(soundCategory({ id: 'a', assetId: 'sound-riser-sweep', start: 0, in: 0, out: 2 })).toBe('riser');
    expect(soundCategory({ id: 'b', assetId: 'upload-1', start: 0, in: 0, out: 30 })).toBe('music');
    expect(soundCategory({ id: 'c', assetId: 'upload-2', start: 0, in: 0, out: 1 })).toBe('other');
  });

  it('says so instead of judging when there is no voice to judge against', () => {
    const report = checkMix(project([sfx('boom', 'sound-impact-boom', 5, 1)]), (id) => (id === 'voice' ? undefined : energy[id]));
    expect(report.voiceReferenceDb).toBeNull();
    expect(report.hits).toEqual([]);
    expect(report.warnings[0]).toMatch(/No measurable voice/);
  });
});
