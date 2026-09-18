import type { VideoAnalyzer } from '../analyzer.js';

/**
 * Deterministic stand-in for a watching model, for tests and offline demos: it
 * claims to have watched and fills every section with fixed answers.
 */
export const mockVideoAnalyzer: VideoAnalyzer = {
  id: 'mock',
  label: 'Offline mock watcher',
  version: '1',
  watches: true,
  availability: () => ({ available: true, detail: 'Fixed answers, free and instant' }),
  async analyzeVideo({ assetId, metrics }) {
    return {
      watched: true,
      summary: `Mock watched ${assetId}: punchy talking head with bold captions.`,
      pacing: { averageShotSeconds: metrics.averageShotLength, cutCount: metrics.cutCount, rhythm: 'fast-punch' },
      hook: { durationSeconds: 2, technique: 'bold on-screen claim' },
      captions: { present: true, position: 'center', style: 'bold white with black stroke', animation: 'word pop' },
      transitions: { dominant: 'hard cut', frequency: 'constant' },
      audio: { loudnessLufs: metrics.loudnessLufs, music: 'trap beat under voice', soundEffects: 'whoosh on cuts', voice: 'energetic' },
      visuals: { colorGrade: 'high contrast', framing: 'tight talking head', punchIns: true, bRoll: 'occasional screen recording' },
      text: { overlays: 'keyword callouts', emoji: true },
      tags: ['bold captions', 'punch-ins', 'talking head'],
    };
  },
};
