import { assetInsightsSchema, type AssetInsights } from '@editify/shared';
import type { ToolProvider } from '../agent/providers.js';
import type { StoredAsset } from '../db/asset-store.js';
import type { InsightStore } from '../db/insight-store.js';
import type { StoredTranscript, TranscriptSegment } from '../db/transcript-store.js';
import type { TranscriptService } from './transcript-service.js';
import { NO_DASHES_RULE } from '../agent/prose-style.js';

const emotiveWords = new Set([
  'amazing', 'angry', 'awesome', 'crazy', 'damn', 'excited', 'fuck', 'fucking', 'hate',
  'hell', 'hilarious', 'insane', 'love', 'shocking', 'shit', 'terrible', 'wow',
]);
const profanity = /\b(?:damn|fuck(?:ing)?|hell|shit)\b/i;

function segmentWordCount(segment: TranscriptSegment): number {
  return segment.text.trim() ? segment.text.trim().split(/\s+/).length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function generateMockInsights(
  assetId: string,
  transcript: Pick<StoredTranscript, 'segments' | 'words'>,
  generatedAt = new Date().toISOString(),
): AssetInsights {
  const segments = transcript.segments.filter((segment) => segment.text.trim().length > 0);
  if (!segments.length) {
    return { assetId, hook: null, highlights: [], summary: 'No speech detected.', generatedAt };
  }

  const rates = segments.map((segment) => segmentWordCount(segment) / Math.max(0.1, segment.e - segment.s));
  const medianRate = median(rates);
  const rawScores = segments.map((segment, index) => {
    const punctuation = (segment.text.match(/[!?]/g) ?? []).length;
    const emotional = segment.text.toLowerCase().split(/[^a-z']+/).filter((word) => emotiveWords.has(word)).length;
    const rateBoost = (rates[index] ?? 0) > medianRate ? 1 : 0;
    return punctuation + emotional + rateBoost;
  });
  const maxScore = Math.max(1, ...rawScores);
  const hookSegment = segments.find((segment) => /[!?]/.test(segment.text) || /\b(?:you|your)\b/i.test(segment.text))
    ?? segments[0];
  const ranked = segments.map((segment, index) => {
    const isTrailing = index === segments.length - 1;
    const label = segment.text.includes('?')
      ? 'question'
      : isTrailing && (profanity.test(segment.text) || segment.text.includes('!'))
        ? 'punchline'
        : 'key claim';
    return {
      start: segment.s,
      end: segment.e,
      text: segment.text,
      score: Number(((rawScores[index] ?? 0) / maxScore).toFixed(4)),
      label,
      index,
    };
  }).sort((left, right) => right.score - left.score || left.index - right.index).slice(0, 3)
    .map(({ index: _index, ...highlight }) => highlight);
  const fullText = transcript.words.length
    ? transcript.words.map((word) => word.w).join(' ')
    : segments.map((segment) => segment.text).join(' ');
  const summaryWords = fullText.trim().split(/\s+/).filter(Boolean).slice(0, 8);

  return assetInsightsSchema.parse({
    assetId,
    hook: hookSegment ? {
      start: hookSegment.s,
      end: hookSegment.e,
      text: hookSegment.text,
      reason: 'Earliest segment with a question, direct address, or emphatic delivery.',
    } : null,
    highlights: ranked,
    summary: `${summaryWords.join(' ')}…`,
    generatedAt,
  });
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  return JSON.parse(fenced ?? trimmed);
}

export class InsightService {
  private readonly inFlight = new Map<string, Promise<AssetInsights>>();

  constructor(
    readonly store: InsightStore,
    private readonly transcripts: TranscriptService,
    /** Resolved per call (and per user) so the UI's provider picker applies without a restart. */
    private readonly provider: (userId?: string) => Promise<ToolProvider>,
  ) {}

  getStored(assetId: string): AssetInsights | undefined {
    return this.store.get(assetId);
  }

  async getOrCreate(asset: StoredAsset, force = false, userId?: string): Promise<AssetInsights | undefined> {
    const existing = this.store.get(asset.id);
    if (existing && !force) return existing;
    const transcript = this.transcripts.get(asset.id);
    if (!transcript) return undefined;
    // ponytail: like transcribe(), a force=true call that lands mid-run joins
    // the in-flight run rather than paying for a second provider round trip.
    const pending = this.inFlight.get(asset.id) ?? this.analyze(asset, transcript, userId)
      .finally(() => this.inFlight.delete(asset.id));
    this.inFlight.set(asset.id, pending);
    return await pending;
  }

  private async analyze(asset: StoredAsset, transcript: StoredTranscript, userId?: string): Promise<AssetInsights> {
    const generatedAt = new Date().toISOString();
    const system = [
      'Analyze this timed transcript for a short-form video edit.',
      'Return only one JSON object matching the supplied asset-insights contract.',
      'Choose a 1-3 second hook and snap every timestamp to the supplied word boundaries.',
      'Rank impactful spans from 0 to 1. Labels must be one of: punchline, setup, emotional peak, key claim, question, callback.',
      'Do not claim visual knowledge; use only transcript evidence.',
      NO_DASHES_RULE,
    ].join(' ');
    const payload = {
      assetId: asset.id,
      duration: asset.duration,
      generatedAt,
      words: transcript.words,
      segments: transcript.segments,
      schema: {
        assetId: 'string', hook: '{start,end,text,reason} | null',
        highlights: '[{start,end,text,score,label}]', summary: 'one line', generatedAt: 'ISO string',
      },
    };
    let validationError = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const user = `${JSON.stringify(payload)}${validationError ? `\nPrevious response was invalid: ${validationError}` : ''}`;
      try {
        const provider = await this.provider(userId);
        const parsed = assetInsightsSchema.parse(parseJsonResponse(await provider.completeText(system, user)));
        if (parsed.assetId !== asset.id) throw new Error(`assetId must be ${asset.id}`);
        return this.store.put(parsed);
      } catch (error) {
        validationError = error instanceof Error ? error.message : String(error);
      }
    }
    // Deliberately NOT persisted: a transient provider failure must not poison
    // the cache forever — the next request simply retries.
    return {
      assetId: asset.id,
      hook: null,
      highlights: [],
      summary: 'Analysis unavailable',
      generatedAt,
    };
  }
}
