/**
 * The words part on this iPhone after an import (D21, C15, C25): queue it, ask for speech
 * permission from a sheet with Editify in front, re-queue it once granted, and say so plainly
 * when speech recognition is off. Free of React Native: the engine, the media registry and the
 * capability cache are passed in, so every branch runs under vitest.
 *
 *   import completes ─▶ words queued for each clip with sound (analyzeMedia, parts ['words'])
 *     └─ SFSpeech is the active transcriber (legacy set, or the chain starts with sfspeech)
 *        and speech permission is notDetermined ─▶ pre-prompt sheet
 *           ├─ Continue ─▶ requestSpeechAuthorization (the system alert) ─┐
 *           └─ Not now ─▶ the part stays unavailable (speechRecognitionNotAsked);
 *                         the next import offers the sheet again          │
 *   speechAuthorization event (after a request, or on foreground) ◀───────┘
 *     ├─ authorized ─▶ re-queue every words part unavailable for speech permission
 *     ├─ denied / restricted ─▶ re-queue the not-asked ones (they come back speechRecognitionOff)
 *     └─ a part with code speechRecognitionOff ─▶ the receipt: "Speech recognition is off for
 *        Editify" with a Settings link (Linking.openSettings), dismissible until the next import
 *
 *   The native words run never prompts (TranscriberChain): it may run with Editify in the
 *   background, where the system alert can't be answered.
 *
 *   analysisStatus ─▶ applyStatusEvent ─ ready ─▶ getAnalysis ─▶ applyAssetAnalysis
 *     words ready ─▶ words_done {adapter, secs} ─▶ capabilities refreshed (lastRan, trigger)
 *       trigger moved (OS update, SpeechAnalyzer model installed) ─▶ markStale ─▶ re-queue (C25)
 */
import type { PlanAssetRef } from '@editify/shared';
import type {
  AnalysisStatusEvent, NativeAssetAnalysis, SpeechAuthorizationEvent, SpeechAuthorizationStatus,
} from '../../modules/editify-engine';
import {
  applyAssetAnalysis, applyStatusEvent, emptyAnalysisState, markStale, type DeviceAnalysisState, type WordsFreshness,
} from './analysis-bundle';
import type { Capabilities, CapabilityCache } from './engine-capabilities';

export const SPEECH_PROMPT_TITLE = 'Captions from your voice';
export const SPEECH_PROMPT_TEXT = 'Editify writes captions by listening on your iPhone. Nothing is uploaded.';
/** The native part's reason (D21), also the receipt's first line. */
export const SPEECH_OFF_TEXT = 'Speech recognition is off for Editify';
export const SPEECH_OFF_DETAIL = 'Captions need it. Turn on Speech Recognition for Editify in Settings.';
export const SPEECH_OFF_CODE = 'speechRecognitionOff';
export const SPEECH_NOT_ASKED_CODE = 'speechRecognitionNotAsked';

/** True when the words part on this iPhone runs through SFSpeech, the transcriber that needs permission. */
export function sfspeechActive(capabilities: Capabilities): boolean {
  return capabilities.adapterSet === 'legacy' || capabilities.transcriber?.order?.[0] === 'sfspeech';
}

/** C15: the sheet only after an import, only for SFSpeech, only while the question is unanswered. */
export function shouldOfferSpeechPrompt(input: { capabilities: Capabilities; status: SpeechAuthorizationStatus | null; imported: boolean }): boolean {
  return input.imported && input.status === 'notDetermined' && sfspeechActive(input.capabilities);
}

/** The words parts to queue again after the permission became `status`. */
export function wordsToRequeue(state: DeviceAnalysisState, status: SpeechAuthorizationStatus): string[] {
  if (status === 'notDetermined') return [];
  const codes = status === 'authorized' ? [SPEECH_OFF_CODE, SPEECH_NOT_ASKED_CODE] : [SPEECH_NOT_ASKED_CODE];
  return Object.entries(state.assets)
    .filter(([, parts]) => parts.words?.status === 'unavailable' && codes.includes(parts.words.code ?? ''))
    .map(([assetId]) => assetId);
}

/** Assets whose words part is unavailable because speech recognition is off. */
export function speechOffAssets(state: DeviceAnalysisState): string[] {
  return Object.entries(state.assets)
    .filter(([, parts]) => parts.words?.status === 'unavailable' && parts.words.code === SPEECH_OFF_CODE)
    .map(([assetId]) => assetId);
}

/** The C25 rule from `capabilities().transcriber`, or null on a binary without the chain. */
export function wordsFreshness(capabilities: Capabilities): WordsFreshness | null {
  const transcriber = capabilities.transcriber;
  if (!transcriber) return null;
  return { best: transcriber.best, versions: Object.values(transcriber.versions).filter((version): version is string => Boolean(version)), trigger: transcriber.trigger };
}

/** The adapter that writes `version` ("w-sf1" ─▶ "sfspeech"), else the one that ran last. */
export function adapterOfVersion(capabilities: Capabilities, version: string): string {
  const entry = Object.entries(capabilities.transcriber?.versions ?? {}).find(([, value]) => value === version);
  return entry?.[0] ?? capabilities.transcriber?.lastRan ?? 'unknown';
}

/** Clips the words part can run on: video or audio with a sound track. */
export function wordsRefs(assets: ReadonlyArray<{ id: string; kind: PlanAssetRef['kind']; hasAudio: boolean }>): PlanAssetRef[] {
  return assets.filter((asset) => asset.hasAudio && (asset.kind === 'video' || asset.kind === 'audio')).map(({ id, kind }) => ({ id, kind }));
}

export interface WordsNative {
  getAnalysis(assetId: string): Promise<NativeAssetAnalysis>;
  speechAuthorization?: () => SpeechAuthorizationStatus;
  requestSpeechAuthorization?: () => Promise<SpeechAuthorizationStatus>;
}

export interface DeviceWordsOptions {
  native: WordsNative;
  /** Queues the words part for one clip (analyzeMedia with parts ['words']); resolves once asked. */
  queue: (ref: PlanAssetRef) => Promise<void>;
  capabilities: CapabilityCache;
  now?: () => number;
  /** A words part became ready: the adapter that wrote it and the seconds since it was queued. */
  onWordsDone?: (event: { adapter: string; secs: number }) => void;
}

export interface WordsView {
  /** The pre-prompt sheet is up. */
  prompt: boolean;
  /** The speech-off receipt is up. */
  speechOff: boolean;
}

export interface DeviceWords {
  /** An import finished: queue words for `refs` and offer the sheet when C15 says so. */
  importCompleted(refs: readonly PlanAssetRef[]): Promise<void>;
  /** The sheet's Continue: the system alert, then the re-queue (through `speechAuthorizationChanged`). */
  continuePrompt(): Promise<SpeechAuthorizationStatus | null>;
  /** The sheet's Not now: nothing is asked, the next import offers it again. */
  notNow(): void;
  dismissSpeechOff(): void;
  analysisStatus(event: AnalysisStatusEvent): Promise<void>;
  speechAuthorizationChanged(event: Pick<SpeechAuthorizationEvent, 'status'>): Promise<void>;
  view(): WordsView;
  state(): DeviceAnalysisState;
  subscribe(listener: (view: WordsView) => void): () => void;
}

export function createDeviceWords(options: DeviceWordsOptions): DeviceWords {
  const now = options.now ?? Date.now;
  let analysis = emptyAnalysisState();
  let view: WordsView = { prompt: false, speechOff: false };
  let speechOffDismissed = false;
  /** Every clip words were queued for, so a re-queue can name its kind. */
  const refs = new Map<string, PlanAssetRef>();
  /** When each clip's words were (re)queued, for words_done. */
  const started = new Map<string, number>();
  let trigger = options.capabilities.current().transcriber?.trigger;
  const listeners = new Set<(view: WordsView) => void>();

  const publish = (next: Partial<WordsView>): void => {
    const merged = { ...view, ...next };
    if (merged.prompt === view.prompt && merged.speechOff === view.speechOff) return;
    view = merged;
    for (const listener of listeners) listener(view);
  };
  const showSpeechOff = (): void => publish({ speechOff: !speechOffDismissed && speechOffAssets(analysis).length > 0 });

  const queue = async (ref: PlanAssetRef): Promise<void> => {
    refs.set(ref.id, ref);
    started.set(ref.id, now());
    try {
      await options.queue(ref);
    } catch {
      started.delete(ref.id); // not on this iPhone any more: nothing runs, nothing to time
    }
  };
  const requeue = async (assetIds: readonly string[]): Promise<void> => {
    await Promise.all(assetIds.map((assetId) => refs.get(assetId)).filter((ref): ref is PlanAssetRef => ref !== undefined).map(queue));
  };
  const status = (): SpeechAuthorizationStatus | null => {
    try {
      return options.native.speechAuthorization?.() ?? options.capabilities.current().speechAuthorization ?? null;
    } catch {
      return null;
    }
  };

  /** C25: a moved trigger (read after words ran) sends fallback results back for one re-run. */
  const rerunIfTriggerMoved = async (capabilities: Capabilities): Promise<void> => {
    const freshness = wordsFreshness(capabilities);
    if (!freshness || freshness.trigger === trigger) return;
    trigger = freshness.trigger;
    const result = markStale(analysis, {}, freshness);
    analysis = result.state;
    await requeue(result.stale.filter((part) => part.part === 'words').map((part) => part.assetId));
  };

  const speechAuthorizationChanged = async (event: Pick<SpeechAuthorizationEvent, 'status'>): Promise<void> => {
    options.capabilities.refresh();
    if (event.status !== 'notDetermined') publish({ prompt: false });
    await requeue(wordsToRequeue(analysis, event.status));
  };

  return {
    async importCompleted(imported) {
      speechOffDismissed = false;
      await Promise.all(imported.map(queue));
      const offer = shouldOfferSpeechPrompt({ capabilities: options.capabilities.current(), status: status(), imported: imported.length > 0 });
      publish({ prompt: offer || view.prompt });
      showSpeechOff();
    },

    async continuePrompt() {
      publish({ prompt: false });
      const request = options.native.requestSpeechAuthorization;
      if (!request) return null;
      const answer = await request().catch(() => null);
      // The engine also sends a speechAuthorization event; re-queueing twice is harmless (the
      // second ask finds the part pending), but answer here so a missed event can't strand it.
      if (answer) await speechAuthorizationChanged({ status: answer });
      return answer;
    },

    notNow() {
      publish({ prompt: false });
    },

    dismissSpeechOff() {
      speechOffDismissed = true;
      publish({ speechOff: false });
    },

    async analysisStatus(event) {
      if (event.part !== 'words') return;
      const applied = applyStatusEvent(analysis, event);
      analysis = applied.state;
      if (applied.refetch) {
        try {
          analysis = applyAssetAnalysis(analysis, await options.native.getAnalysis(event.assetId));
        } catch { /* the next event or snapshot catches up */ }
      }
      const part = analysis.assets[event.assetId]?.words;
      if (part?.status === 'ready') {
        const capabilities = options.capabilities.refresh();
        const since = started.get(event.assetId);
        if (since !== undefined) {
          started.delete(event.assetId);
          options.onWordsDone?.({ adapter: adapterOfVersion(capabilities, part.analyzerVersion), secs: Math.round((now() - since) / 100) / 10 });
        }
        await rerunIfTriggerMoved(capabilities);
      }
      showSpeechOff();
    },

    speechAuthorizationChanged,

    view: () => view,
    state: () => analysis,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
