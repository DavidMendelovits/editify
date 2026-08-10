import { describe, expect, it } from 'vitest';
import { generateMockInsights } from '../src/services/insight-service.js';

describe('mock transcript insights', () => {
  it('selects the earliest question/direct-address segment as the hook', () => {
    const result = generateMockInsights('asset-1', {
      words: [],
      segments: [
        { text: 'A quiet opening', s: 0, e: 2 },
        { text: 'Did you know this?', s: 2, e: 3.5 },
        { text: 'This is amazing!', s: 3.5, e: 4.5 },
      ],
    }, '2026-01-01T00:00:00.000Z');
    expect(result.hook).toMatchObject({ start: 2, end: 3.5, text: 'Did you know this?' });
    const scores = Object.fromEntries(result.highlights.map((highlight) => [highlight.text, highlight.score]));
    expect(scores['This is amazing!']).toBeGreaterThan(scores['A quiet opening'] ?? 0);
  });

  it('handles an empty transcript honestly', () => {
    expect(generateMockInsights('asset-empty', { words: [], segments: [] }, 'now')).toEqual({
      assetId: 'asset-empty', hook: null, highlights: [], summary: 'No speech detected.', generatedAt: 'now',
    });
  });
});
