import { describe, expect, it } from 'vitest';
import type { PlanAssetRef } from '@editify/shared';
import type { AnalysisStatusEvent, EngineCapabilities, NativeAssetAnalysis, SpeechAuthorizationStatus } from '../../modules/editify-engine';
import { createCapabilityCache } from './engine-capabilities';
import {
  adapterOfVersion, createDeviceWords, SPEECH_NOT_ASKED_CODE, SPEECH_OFF_CODE, SPEECH_PROMPT_TEXT, shouldOfferSpeechPrompt,
  speechOffAssets, wordsFreshness, wordsRefs, wordsToRequeue,
} from './device-words';
import { emptyAnalysisState, type DeviceAnalysisState } from './analysis-bundle';

const STATUSES: SpeechAuthorizationStatus[] = ['notDetermined', 'denied', 'restricted', 'authorized'];

function caps(set: 'legacy' | 'modern', overrides: Partial<EngineCapabilities> = {}): EngineCapabilities {
  return {
    os: set === 'legacy' ? '18.0.0' : '26.5.0',
    adapterSet: set,
    transcriber: set === 'legacy'
      ? { order: ['sfspeech'], lastRan: null, best: 'w-sf1', versions: { sfspeech: 'w-sf1' }, trigger: 'os=18.0;sa=0' }
      : { order: ['speech-analyzer', 'sfspeech'], lastRan: null, best: 'w-sa1', versions: { 'speech-analyzer': 'w-sa1', sfspeech: 'w-sf1' }, trigger: 'os=26.5;sa=0' },
    speechAuthorization: 'notDetermined',
    backgroundExport: 'foreground',
    backgroundGPU: false,
    composition: set === 'legacy' ? 'mutable' : 'configuration',
    tier: 'full',
    ...overrides,
  };
}

describe('the speech pre-prompt decision (C15)', () => {
  // adapter set × permission × what the imported clip's words part came back with: the sheet for
  // every not-asked part while the question is unanswered, whichever adapter set ran.
  const outcomes = [SPEECH_NOT_ASKED_CODE, SPEECH_OFF_CODE] as const;
  const cases = (['legacy', 'modern'] as const).flatMap((set) => STATUSES.flatMap((status) => outcomes.map((code) => ({ set, status, code }))));
  it.each(cases)('$set, $status, words came back $code', async ({ set, status, code }) => {
    const h = harness({ set, status });
    await h.words.importCompleted([clip('a')]);
    expect(h.words.view().prompt).toBe(false); // nothing until the part answers
    await h.words.analysisStatus({ assetId: 'a', part: 'words', status: 'unavailable', analyzerVersion: 'w-sf1', code });
    expect(h.words.view().prompt).toBe(status === 'notDetermined' && code === SPEECH_NOT_ASKED_CODE);
  });

  it('asks only for a part from an import, only for not-asked, only while unanswered', () => {
    expect(shouldOfferSpeechPrompt({ fromImport: true, code: SPEECH_NOT_ASKED_CODE, status: 'notDetermined' })).toBe(true);
    expect(shouldOfferSpeechPrompt({ fromImport: false, code: SPEECH_NOT_ASKED_CODE, status: 'notDetermined' })).toBe(false);
    expect(shouldOfferSpeechPrompt({ fromImport: true, code: undefined, status: 'notDetermined' })).toBe(false);
    expect(shouldOfferSpeechPrompt({ fromImport: true, code: SPEECH_NOT_ASKED_CODE, status: null })).toBe(false);
  });

  it('says what it says', () => {
    expect(SPEECH_PROMPT_TEXT).toBe('Editify listens on your iPhone to find the words in your clips.');
  });
});

describe('words parts to queue again', () => {
  const state: DeviceAnalysisState = {
    ...emptyAnalysisState(),
    assets: {
      off: { words: { status: 'unavailable', analyzerVersion: 'w-sf1', error: 'Speech recognition is off for Editify', code: SPEECH_OFF_CODE } },
      asked: { words: { status: 'unavailable', analyzerVersion: 'w-sf1', code: SPEECH_NOT_ASKED_CODE } },
      silent: { words: { status: 'unavailable', analyzerVersion: 'w-sf1', error: 'This recording has no audio' } },
      done: { words: { status: 'ready', analyzerVersion: 'w-sf1', data: {} } },
      energyOnly: { energy: { status: 'ready', analyzerVersion: 'energy-rms-50ms-2', data: {} } },
    },
  };

  it('re-queues every permission-blocked part on authorized, the not-asked ones on a refusal, none while unanswered', () => {
    expect(wordsToRequeue(state, 'authorized').sort()).toEqual(['asked', 'off']);
    expect(wordsToRequeue(state, 'denied')).toEqual(['asked']);
    expect(wordsToRequeue(state, 'restricted')).toEqual(['asked']);
    expect(wordsToRequeue(state, 'notDetermined')).toEqual([]);
    expect(speechOffAssets(state)).toEqual(['off']);
  });

  it('queues words only for video and audio with sound', () => {
    expect(wordsRefs([
      { id: 'v', kind: 'video', hasAudio: true }, { id: 'mute', kind: 'video', hasAudio: false },
      { id: 'a', kind: 'audio', hasAudio: true }, { id: 'img', kind: 'image', hasAudio: false },
    ])).toEqual([{ id: 'v', kind: 'video' }, { id: 'a', kind: 'audio' }]);
  });

  it('reads the C25 rule and the adapter of a version from capabilities', () => {
    expect(wordsFreshness(caps('modern'))).toEqual({ best: 'w-sa1', versions: ['w-sa1', 'w-sf1'], trigger: 'os=26.5;sa=0' });
    expect(wordsFreshness({})).toBeNull();
    expect(adapterOfVersion(caps('modern'), 'w-sf1')).toBe('sfspeech');
    expect(adapterOfVersion({ transcriber: { ...caps('legacy').transcriber, lastRan: 'sfspeech' } }, 'w-old')).toBe('sfspeech');
    expect(adapterOfVersion({}, 'w-sf1')).toBe('unknown');
  });
});

const clip = (id: string): PlanAssetRef => ({ id, kind: 'video' });

/** A fake engine: its permission, the words part per asset, and what was queued. */
function harness(initial: { set?: 'legacy' | 'modern'; status?: SpeechAuthorizationStatus } = {}) {
  let status: SpeechAuthorizationStatus = initial.status ?? 'notDetermined';
  let capabilities = caps(initial.set ?? 'legacy');
  const analyses = new Map<string, NativeAssetAnalysis>();
  const queued: string[] = [];
  const done: Array<{ adapter: string; secs: number }> = [];
  let clock = 1_000;
  let requests = 0;
  let answer: SpeechAuthorizationStatus = 'authorized';
  const engine = {
    exportCapabilities: () => ({ ...capabilities, speechAuthorization: status }),
    capabilities: () => ({ ...capabilities, speechAuthorization: status }),
  };
  const cache = createCapabilityCache(engine);
  const words = createDeviceWords({
    native: {
      getAnalysis: async (assetId) => analyses.get(assetId) ?? { assetId, parts: {} },
      speechAuthorization: () => status,
      requestSpeechAuthorization: async () => {
        requests += 1;
        if (status === 'notDetermined') status = answer;
        return status;
      },
    },
    capabilities: cache,
    queue: async (ref: PlanAssetRef) => { queued.push(ref.id); },
    now: () => clock,
    onWordsDone: (event) => done.push(event),
  });
  /** The native scheduler's answer for a words run with the permission as it is now. */
  const run = async (assetId: string, ready = status === 'authorized', version = capabilities.transcriber.best): Promise<void> => {
    const event: AnalysisStatusEvent = ready
      ? { assetId, part: 'words', status: 'ready', analyzerVersion: version }
      : { assetId, part: 'words', status: 'unavailable', analyzerVersion: 'w-sf1', code: status === 'notDetermined' ? SPEECH_NOT_ASKED_CODE : SPEECH_OFF_CODE,
        error: status === 'notDetermined' ? 'Editify needs permission to recognize speech' : 'Speech recognition is off for Editify' };
    if (ready) analyses.set(assetId, { assetId, parts: { words: { status: 'ready', analyzerVersion: version, data: { words: [] }, trigger: capabilities.transcriber.trigger } } });
    await words.analysisStatus(event);
  };
  return {
    words, queued, done, cache,
    run,
    get requests() { return requests; },
    setAnswer: (next: SpeechAuthorizationStatus) => { answer = next; },
    setStatus: (next: SpeechAuthorizationStatus) => { status = next; },
    setCapabilities: (next: EngineCapabilities) => { capabilities = next; },
    tick: (ms: number) => { clock += ms; },
  };
}

describe('the device words flow', () => {
  it('queues words on import and offers the sheet once they come back not asked; Continue asks once and re-queues on allow', async () => {
    const h = harness();
    await h.words.importCompleted([clip('a')]);
    expect(h.queued).toEqual(['a']);
    expect(h.words.view().prompt).toBe(false);
    await h.run('a'); // the words run did not prompt: not asked yet
    expect(h.words.state().assets.a?.words?.code).toBe(SPEECH_NOT_ASKED_CODE);
    expect(h.words.view().prompt).toBe(true);

    expect(await h.words.continuePrompt()).toBe('authorized');
    expect(h.requests).toBe(1);
    expect(h.words.view().prompt).toBe(false);
    expect(h.queued).toEqual(['a', 'a']);
    h.tick(4_250);
    await h.run('a');
    expect(h.words.state().assets.a?.words?.status).toBe('ready');
    expect(h.done).toEqual([{ adapter: 'sfspeech', secs: 4.3 }]);
  });

  it('Not now keeps the part unavailable, holds for the rest of that import, and asks again on the next one', async () => {
    const h = harness();
    await h.words.importCompleted([clip('a'), clip('c')]);
    await h.run('a');
    expect(h.words.view().prompt).toBe(true);
    h.words.notNow();
    expect(h.words.view().prompt).toBe(false);
    expect(h.requests).toBe(0);
    expect(h.words.state().assets.a?.words).toMatchObject({ status: 'unavailable', code: SPEECH_NOT_ASKED_CODE });
    await h.run('c'); // the same import's second clip: answered already
    expect(h.words.view().prompt).toBe(false);
    await h.words.importCompleted([clip('b')]);
    expect(h.words.view().prompt).toBe(false);
    await h.run('b');
    expect(h.words.view().prompt).toBe(true);
    expect(h.queued).toEqual(['a', 'c', 'b']);
  });

  it('offers it on iOS 26 when SpeechAnalyzer was ineligible and the chain fell to SFSpeech', async () => {
    // Offline before the model installs, or an unsupported locale: the modern chain's SFSpeech
    // fallback needs the permission like the legacy set does.
    const h = harness({ set: 'modern' });
    await h.words.importCompleted([clip('a')]);
    expect(h.words.view().prompt).toBe(false);
    await h.run('a');
    expect(h.words.state().assets.a?.words?.code).toBe(SPEECH_NOT_ASKED_CODE);
    expect(h.words.view().prompt).toBe(true);
    expect(await h.words.continuePrompt()).toBe('authorized');
    expect(h.queued).toEqual(['a', 'a']);
  });

  it('never offers the sheet when SpeechAnalyzer transcribed, once answered, for an empty import, or for a part not from an import', async () => {
    const modern = harness({ set: 'modern', status: 'authorized' });
    await modern.words.importCompleted([clip('a')]);
    await modern.run('a');
    expect(modern.words.view().prompt).toBe(false);
    const answered = harness({ status: 'denied' });
    await answered.words.importCompleted([clip('a')]);
    await answered.run('a');
    expect(answered.words.view().prompt).toBe(false);
    const empty = harness();
    await empty.words.importCompleted([]);
    expect(empty.words.view().prompt).toBe(false);
    const stray = harness();
    await stray.run('elsewhere'); // queued by something other than an import
    expect(stray.words.state().assets.elsewhere?.words?.code).toBe(SPEECH_NOT_ASKED_CODE);
    expect(stray.words.view().prompt).toBe(false);
  });

  it('a refusal turns not-asked parts into speech-off ones and shows the Settings receipt until dismissed', async () => {
    const h = harness();
    h.setAnswer('denied');
    await h.words.importCompleted([clip('a')]);
    await h.run('a');
    expect(await h.words.continuePrompt()).toBe('denied');
    expect(h.queued).toEqual(['a', 'a']); // asked again so the part says why
    await h.run('a');
    expect(h.words.state().assets.a?.words?.code).toBe(SPEECH_OFF_CODE);
    expect(h.words.view().speechOff).toBe(true);
    h.words.dismissSpeechOff();
    expect(h.words.view().speechOff).toBe(false);
    // Turned on in Settings, back in the app: the foreground event re-queues it.
    h.setStatus('authorized');
    await h.words.speechAuthorizationChanged({ status: 'authorized' });
    expect(h.queued).toEqual(['a', 'a', 'a']);
    await h.run('a');
    expect(h.words.state().assets.a?.words?.status).toBe('ready');
    expect(h.words.view().speechOff).toBe(false);
  });

  it('re-runs a fallback result once when the C25 trigger moves after a words run', async () => {
    const h = harness({ set: 'modern', status: 'authorized' });
    await h.words.importCompleted([clip('a'), clip('b')]);
    // SpeechAnalyzer couldn't run for a: SFSpeech's fallback, under trigger sa=0.
    await h.run('a', true, 'w-sf1');
    expect(h.done).toEqual([{ adapter: 'sfspeech', secs: 0 }]);
    // b's run installed the SpeechAnalyzer model: the engine's trigger moved.
    h.setCapabilities(caps('modern', { transcriber: { ...caps('modern').transcriber, trigger: 'os=26.5;sa=1', lastRan: 'speech-analyzer' } }));
    await h.run('b', true, 'w-sa1');
    expect(h.queued).toEqual(['a', 'b', 'a']);
    expect(h.words.state().assets.a?.words).toEqual({ status: 'pending', analyzerVersion: 'w-sa1' });
    // The re-run falls back again under the new trigger: current now, no loop.
    await h.run('a', true, 'w-sf1');
    await h.run('b', true, 'w-sa1');
    expect(h.queued).toEqual(['a', 'b', 'a']);
  });
});
