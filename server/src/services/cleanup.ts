// The cleanup planners are pure edit logic in @editify/shared (device-first plan,
// P1). The server feeds them from its stores through silenceSources.
import type { SilenceSources } from '@editify/shared';
import type { AssetStore } from '../db/asset-store.js';
import type { TranscriptService } from './transcript-service.js';

export {
  FILLER_WORDS,
  SILENCE_DEFAULTS,
  SOUND_ID_PREFIX,
  audibleWindows,
  buildTimelineTranscript,
  mergeRanges,
  normalizeWord,
  planFillerRanges,
  planSilenceRanges,
  planWordCutRanges,
  planWordRemovalRanges,
  totalRangeSeconds,
  unionRanges,
  type AudibleWindow,
  type CleanupRange,
  type FillerPlan,
  type SilenceOptions,
  type SilencePlan,
  type SilenceSources,
  type TimelineTranscript,
  type TimelineTranscriptWord,
} from '@editify/shared';

export function silenceSources(assets: Pick<AssetStore, 'get'>, transcripts: Pick<TranscriptService, 'get' | 'ensureEnergy'>): SilenceSources {
  return {
    hasAsset: (assetId) => Boolean(assets.get(assetId)),
    energyOf: async (assetId) => {
      const asset = assets.get(assetId);
      return transcripts.get(assetId)?.energy ?? (asset ? await transcripts.ensureEnergy(asset) : undefined);
    },
  };
}
