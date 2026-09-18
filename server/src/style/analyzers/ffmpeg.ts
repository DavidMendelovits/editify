import type { VideoAnalyzer } from '../analyzer.js';
import { rhythmFor } from '../observation.js';

/**
 * The no-model baseline: turns the ffmpeg metrics the pipeline already
 * measured into an observation. Always available, costs nothing, and is the
 * fallback when no watching analyzer is configured. `watched` stays false so
 * the brief never claims to have seen the footage.
 */
export const ffmpegAnalyzer: VideoAnalyzer = {
  id: 'ffmpeg',
  label: 'ffmpeg metrics only',
  version: '1',
  watches: false,
  availability: () => ({ available: true, detail: 'Scene changes and loudness from ffmpeg, no video sent anywhere' }),
  async analyzeVideo({ metrics }) {
    const rhythm = rhythmFor(metrics.averageShotLength);
    return {
      watched: false,
      summary: `${rhythm} pacing at about ${metrics.averageShotLength.toFixed(1)}s per shot.`,
      pacing: { averageShotSeconds: metrics.averageShotLength, cutCount: metrics.cutCount, rhythm },
      audio: { loudnessLufs: metrics.loudnessLufs },
      tags: [rhythm],
    };
  },
};
