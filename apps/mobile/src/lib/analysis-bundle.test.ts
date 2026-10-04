import { describe, expect, it } from 'vitest';
import { analysisBundleSchema, readyPart } from '@editify/shared';
import type { NativeEnergy, NativeFaces, NativeLaughter, NativeSync, NativeTranscript } from '../../modules/editify-engine';
import { applyAssetAnalysis, applyPartResult, applyStatusEvent, applySync, buildAnalysisBundle, emptyAnalysisState, markStale, nextPartState, wordsCurrent, type WordsFreshness } from './analysis-bundle';

const transcript: NativeTranscript = {
  language: 'en', durationProcessedSeconds: 12.5,
  words: [{ w: 'Hello', s: 0.4, e: 0.8 }, { w: 'there.', s: 0.85, e: 1.2 }],
  segments: [{ text: 'Hello there.', s: 0.4, e: 1.2 }],
};
const energy: NativeEnergy = { cellSeconds: 0.05, rmsDb: [-30, -12.5, -100, -20], onsetPeaks: [0.05] };
const faces: NativeFaces = { fps: 2, width: 2160, height: 3840, samples: [[0, 0.21, 0.58, 0.38, 0.62], [0.5, null]] };
const laughter: NativeLaughter = { minConfidence: 0.5, spans: [{ s: 10, e: 14.2, confidence: 0.9, meanConfidence: 0.7, windows: 3 }] };
const sync: NativeSync = {
  lag: 59.424, anchor: 120, rate: 1, coarseRatio: 11.8, fineScore: 9.1, confident: true, overlapSec: 212,
  windows: [{ at: 100, lag: 59.424, score: 9.1 }],
};

describe('part status transitions', () => {
  it('pending, then ready with data', () => {
    let state = applyPartResult(emptyAnalysisState(), 'a', 'words', { status: 'pending', analyzerVersion: 'w1' });
    expect(state.assets.a?.words).toEqual({ status: 'pending', analyzerVersion: 'w1' });
    state = applyPartResult(state, 'a', 'words', { status: 'ready', analyzerVersion: 'w1', data: transcript });
    expect(state.assets.a?.words?.status).toBe('ready');
    expect(state.assets.a?.words?.data).toEqual(transcript);
  });

  it('keeps ready data when the same analyzer re-queues the part', () => {
    const ready = { status: 'ready' as const, analyzerVersion: 'w1', data: transcript };
    expect(nextPartState(ready, { status: 'pending', analyzerVersion: 'w1' })).toBe(ready);
  });

  it('drops ready data when a newer analyzer queues the part', () => {
    const ready = { status: 'ready' as const, analyzerVersion: 'w1', data: transcript };
    expect(nextPartState(ready, { status: 'pending', analyzerVersion: 'w2' })).toEqual({ status: 'pending', analyzerVersion: 'w2' });
  });

  it('a ready result without data is a failure', () => {
    expect(nextPartState(undefined, { status: 'ready', analyzerVersion: 'f1' })).toMatchObject({ status: 'failed', analyzerVersion: 'f1' });
  });

  it('unavailable keeps its reason and carries no data', () => {
    const next = nextPartState(undefined, { status: 'unavailable', analyzerVersion: 'w1', error: 'The speech model for en-US is not installed', data: transcript });
    expect(next).toEqual({ status: 'unavailable', analyzerVersion: 'w1', error: 'The speech model for en-US is not installed' });
  });

  it('folds a whole getAnalysis answer in', () => {
    const state = applyAssetAnalysis(emptyAnalysisState(), {
      assetId: 'clip',
      parts: { energy: { status: 'ready', analyzerVersion: 'e1', data: energy }, faces: { status: 'failed', analyzerVersion: 'f1', error: 'boom' } },
    });
    expect(state.assets.clip?.energy?.status).toBe('ready');
    expect(state.assets.clip?.faces).toEqual({ status: 'failed', analyzerVersion: 'f1', error: 'boom' });
  });
});

describe('status events', () => {
  it('a ready event asks for a refetch instead of failing the data-less part', () => {
    const pending = applyPartResult(emptyAnalysisState(), 'a', 'words', { status: 'pending', analyzerVersion: 'w1' });
    const { state, refetch } = applyStatusEvent(pending, { assetId: 'a', part: 'words', status: 'ready', analyzerVersion: 'w1' });
    expect(refetch).toBe(true);
    expect(state.assets.a?.words).toEqual({ status: 'pending', analyzerVersion: 'w1' });
    const fetched = applyAssetAnalysis(state, { assetId: 'a', parts: { words: { status: 'ready', analyzerVersion: 'w1', data: transcript } } });
    expect(fetched.assets.a?.words?.status).toBe('ready');
  });

  it('applies pending, failed and unavailable events directly', () => {
    const { state, refetch } = applyStatusEvent(emptyAnalysisState(), { assetId: 'a', part: 'faces', status: 'unavailable', analyzerVersion: 'f1', error: 'offline' });
    expect(refetch).toBe(false);
    expect(state.assets.a?.faces).toEqual({ status: 'unavailable', analyzerVersion: 'f1', error: 'offline' });
  });

  it('a removed event drops the cancelled pending part and keeps the rest', () => {
    let state = applyPartResult(emptyAnalysisState(), 'a', 'faces', { status: 'pending', analyzerVersion: 'f1' });
    state = applyPartResult(state, 'a', 'energy', { status: 'ready', analyzerVersion: 'e1', data: energy });
    const next = applyStatusEvent(state, { assetId: 'a', part: 'faces', removed: true }).state;
    expect(next.assets.a?.faces).toBeUndefined();
    expect(next.assets.a?.energy?.status).toBe('ready');
  });

  it('getAnalysis is the source of truth: parts it no longer returns are dropped', () => {
    let state = applyPartResult(emptyAnalysisState(), 'a', 'faces', { status: 'pending', analyzerVersion: 'f1' });
    state = applyPartResult(state, 'a', 'energy', { status: 'ready', analyzerVersion: 'e1', data: energy });
    const next = applyAssetAnalysis(state, { assetId: 'a', parts: { energy: { status: 'ready', analyzerVersion: 'e1', data: energy } } });
    expect(Object.keys(next.assets.a ?? {})).toEqual(['energy']);
  });
});

describe('revisions', () => {
  it('drops a getAnalysis snapshot older than an event already applied', () => {
    let state = applyStatusEvent(emptyAnalysisState(), { assetId: 'a', part: 'faces', revision: 3, status: 'failed', analyzerVersion: 'f1', error: 'boom' }).state;
    state = applyAssetAnalysis(state, { assetId: 'a', revision: 2, parts: { faces: { status: 'pending', analyzerVersion: 'f1' } } });
    expect(state.assets.a?.faces?.status).toBe('failed');
    state = applyAssetAnalysis(state, { assetId: 'a', revision: 4, parts: { faces: { status: 'ready', analyzerVersion: 'f1', data: faces } } });
    expect(state.assets.a?.faces?.status).toBe('ready');
    expect(state.revisions.a).toBe(4);
  });

  it('ignores a duplicate or late event', () => {
    const state = applyAssetAnalysis(emptyAnalysisState(), { assetId: 'a', revision: 5, parts: { words: { status: 'ready', analyzerVersion: 'w1', data: transcript } } });
    const late = applyStatusEvent(state, { assetId: 'a', part: 'words', revision: 4, status: 'pending', analyzerVersion: 'w2' });
    expect(late.state.assets.a?.words?.status).toBe('ready');
    expect(late.refetch).toBe(false);
  });
});

describe('buildAnalysisBundle', () => {
  function fullState() {
    let state = emptyAnalysisState();
    state = applyPartResult(state, 'video', 'words', { status: 'ready', analyzerVersion: 'w1', data: transcript });
    state = applyPartResult(state, 'video', 'energy', { status: 'ready', analyzerVersion: 'e1', data: energy });
    state = applyPartResult(state, 'video', 'faces', { status: 'ready', analyzerVersion: 'f1', data: faces });
    state = applyPartResult(state, 'video', 'laughter', { status: 'ready', analyzerVersion: 'l1', data: laughter });
    state = applyPartResult(state, 'video', 'decode', { status: 'ready', analyzerVersion: 'd1', data: { sampleRate: 8000, sampleCount: 100, seconds: 0.0125 } });
    state = applyPartResult(state, 'memo', 'words', { status: 'unavailable', analyzerVersion: 'w1', error: 'offline' });
    state = applyPartResult(state, 'memo', 'faces', { status: 'unavailable', analyzerVersion: 'f1', error: 'The recording has no video track' });
    return applySync(state, 'video', 'memo', { status: 'ready', analyzerVersion: 's1', data: sync });
  }

  it('produces a bundle the shared schema accepts', () => {
    const { bundle, extras } = buildAnalysisBundle(fullState());
    expect(analysisBundleSchema.safeParse(bundle).success).toBe(true);
    expect(readyPart(bundle.assets.video?.transcript)?.words).toHaveLength(2);
    expect(readyPart(bundle.assets.video?.energy)).toEqual({ cellSeconds: 0.05, rmsDb: [-30, -12.5, -100, -20] });
    expect(readyPart(bundle.assets.video?.faces)?.samples[1]).toEqual([0.5, null]);
    expect(bundle.assets.memo?.transcript).toEqual({ status: 'unavailable', analyzerVersion: 'w1' });
    expect(bundle.syncs).toEqual([{ videoAssetId: 'video', memoAssetId: 'memo', status: 'ready', analyzerVersion: 's1', measurement: sync }]);
    expect(extras.onsetPeaks.video).toEqual([0.05]);
    expect(extras.laughter.video?.data?.spans[0]?.confidence).toBe(0.9);
  });

  it('fails one malformed part instead of the whole bundle', () => {
    const bad = applyPartResult(fullState(), 'video', 'faces', {
      status: 'ready', analyzerVersion: 'f1', data: { fps: 2, width: 1080, height: 1920, samples: [[0, 'top']] },
    });
    const { bundle } = buildAnalysisBundle(bad);
    expect(bundle.assets.video?.faces).toEqual({ status: 'failed', analyzerVersion: 'f1' });
    expect(bundle.assets.video?.transcript?.status).toBe('ready');
  });

  it('a pending sync carries no measurement and a malformed one fails', () => {
    let state = applySync(emptyAnalysisState(), 'v', 'm', { status: 'pending', analyzerVersion: 's1' });
    expect(buildAnalysisBundle(state).bundle.syncs[0]).toEqual({ videoAssetId: 'v', memoAssetId: 'm', status: 'pending', analyzerVersion: 's1' });
    state = applySync(state, 'v', 'm', { status: 'ready', analyzerVersion: 's1', data: { ...sync, rate: -1 } });
    expect(buildAnalysisBundle(state).bundle.syncs).toEqual([{ videoAssetId: 'v', memoAssetId: 'm', status: 'failed', analyzerVersion: 's1' }]);
  });

  it('replaces a pair\'s sync rather than adding a second one', () => {
    let state = applySync(emptyAnalysisState(), 'v', 'm', { status: 'failed', analyzerVersion: 's1', error: 'silent' });
    state = applySync(state, 'v', 'm', { status: 'ready', analyzerVersion: 's1', data: sync });
    state = applySync(state, 'v', 'other', { status: 'pending', analyzerVersion: 's1' });
    expect(state.syncs).toHaveLength(2);
  });
});

describe('markStale', () => {
  it('a version bump sends that part back to pending and lists it', () => {
    let state = applyPartResult(emptyAnalysisState(), 'video', 'words', { status: 'ready', analyzerVersion: 'speechanalyzer-ios26-1', data: transcript });
    state = applyPartResult(state, 'video', 'energy', { status: 'ready', analyzerVersion: 'energy-rms-50ms-1', data: energy });
    state = applySync(state, 'video', 'memo', { status: 'ready', analyzerVersion: 'audiosync-vdsp-1', data: sync });
    const { state: next, stale } = markStale(state, { words: 'speechanalyzer-ios26-2', energy: 'energy-rms-50ms-1', sync: 'audiosync-vdsp-2' });
    expect(next.assets.video?.words).toEqual({ status: 'pending', analyzerVersion: 'speechanalyzer-ios26-2' });
    expect(next.assets.video?.energy?.status).toBe('ready');
    expect(next.syncs[0]).toEqual({ videoAssetId: 'video', memoAssetId: 'memo', status: 'pending', analyzerVersion: 'audiosync-vdsp-2' });
    expect(stale).toEqual([{ assetId: 'video', part: 'words' }, { assetId: 'video', part: 'sync', memoAssetId: 'memo' }]);
    const { bundle } = buildAnalysisBundle(next);
    expect(readyPart(bundle.assets.video?.transcript)).toBeUndefined();
    expect(analysisBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('leaves parts alone when versions match or are unknown', () => {
    const state = applyPartResult(emptyAnalysisState(), 'a', 'faces', { status: 'ready', analyzerVersion: 'f1', data: faces });
    const { state: next, stale } = markStale(state, { words: 'w9' });
    expect(next.assets.a?.faces?.status).toBe('ready');
    expect(stale).toEqual([]);
  });
});

describe('markStale: words re-run once per trigger (C25)', () => {
  const ios26: WordsFreshness = { best: 'w-sa1', versions: ['w-sa1', 'w-sf1'], trigger: 'os=26.0;sa=0' };

  it('keeps the best adapter\'s result, and a fallback\'s until the trigger moves', () => {
    expect(wordsCurrent(ios26, { analyzerVersion: 'w-sa1' })).toBe(true);
    expect(wordsCurrent(ios26, { analyzerVersion: 'w-sf1', trigger: 'os=26.0;sa=0' })).toBe(true);
    expect(wordsCurrent(ios26, { analyzerVersion: 'w-sf1', trigger: 'os=18.7;sa=0' })).toBe(false);
    expect(wordsCurrent(ios26, { analyzerVersion: 'w-sf1' })).toBe(false);
    // An analyzer this build no longer writes is stale whatever it carries.
    expect(wordsCurrent(ios26, { analyzerVersion: 'speechanalyzer-ios26-2', trigger: 'os=26.0;sa=0' })).toBe(false);
    // On iOS 18 SFSpeech is the best adapter: its result never waits for a trigger.
    expect(wordsCurrent({ best: 'w-sf1', versions: ['w-sf1'], trigger: 'os=18.7;sa=0' }, { analyzerVersion: 'w-sf1', trigger: 'os=18.0;sa=0' })).toBe(true);
  });

  it('re-runs an iOS 18 transcript once after the update to 26, and not again when the model install keeps failing', () => {
    // Transcribed on iOS 18 by SFSpeech.
    let state = applyPartResult(emptyAnalysisState(), 'video', 'words', { status: 'ready', analyzerVersion: 'w-sf1', trigger: 'os=18.7;sa=0', data: transcript });
    let runs = 0;
    for (let session = 0; session < 5; session += 1) {
      const { state: next, stale } = markStale(state, {}, ios26);
      state = next;
      for (const item of stale) {
        expect(item).toEqual({ assetId: 'video', part: 'words' });
        expect(state.assets.video?.words).toEqual({ status: 'pending', analyzerVersion: 'w-sa1' });
        runs += 1;
        // The SpeechAnalyzer model download fails, so the chain falls through to SFSpeech again,
        // stamping the current trigger.
        state = applyAssetAnalysis(state, { assetId: 'video', parts: { words: { status: 'ready', analyzerVersion: 'w-sf1', trigger: ios26.trigger, data: transcript } } });
      }
    }
    expect(runs).toBe(1);
    expect(state.assets.video?.words?.status).toBe('ready');
  });

  it('re-runs once more after a SpeechAnalyzer model install moves the trigger', () => {
    const state = applyPartResult(emptyAnalysisState(), 'video', 'words', { status: 'ready', analyzerVersion: 'w-sf1', trigger: ios26.trigger, data: transcript });
    expect(markStale(state, {}, ios26).stale).toEqual([]);
    expect(markStale(state, {}, { ...ios26, trigger: 'os=26.0;sa=1' }).stale).toEqual([{ assetId: 'video', part: 'words' }]);
  });

  it('carries the unavailable code and the trigger from status events', () => {
    const { state } = applyStatusEvent(emptyAnalysisState(), {
      assetId: 'a', part: 'words', revision: 1, status: 'unavailable', analyzerVersion: 'w-sf1',
      error: 'Speech recognition is off for Editify', code: 'speechRecognitionOff', trigger: 'os=18.0;sa=0',
    });
    expect(state.assets.a?.words).toEqual({
      status: 'unavailable', analyzerVersion: 'w-sf1', error: 'Speech recognition is off for Editify', code: 'speechRecognitionOff', trigger: 'os=18.0;sa=0',
    });
  });
});
