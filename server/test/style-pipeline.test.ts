import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredAsset } from '../src/db/asset-store.js';
import { createDatabase, type EditifyDatabase } from '../src/db/database.js';
import { SettingsStore } from '../src/db/settings-store.js';
import { composeAnalyzer, type VideoAnalyzer } from '../src/style/analyzer.js';
import { ffmpegAnalyzer } from '../src/style/analyzers/ffmpeg.js';
import { GeminiVideoAnalyzer } from '../src/style/analyzers/gemini.js';
import { mockVideoAnalyzer } from '../src/style/analyzers/mock.js';
import { WebhookVideoAnalyzer } from '../src/style/analyzers/webhook.js';
import { ObservationCache } from '../src/style/observation-cache.js';
import { runStylePipeline, type PipelineProgress } from '../src/style/pipeline.js';
import { ANALYZER_SETTING_KEY, StyleAnalyzerRegistry } from '../src/style/registry.js';
import { buildStyleTemplate, describeTemplate } from '../src/style/template.js';

vi.mock('../src/media/process.js', () => ({
  analyzeScenes: async (path: string) => (path.endsWith('slow.mp4')
    ? { cutCount: 1, cutDensity: 0.1, averageShotLength: 5 }
    : { cutCount: 5, cutDensity: 0.5, averageShotLength: 1.5 }),
  analyzeLoudness: async () => -12,
}));

const scratch = mkdtempSync(join(tmpdir(), 'editify-style-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function asset(id: string, file = 'fast.mp4'): StoredAsset {
  const originalPath = join(scratch, `${id}-${file}`);
  writeFileSync(originalPath, 'not really a video');
  return {
    id, originalName: file, mimeType: 'video/mp4', duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true,
    originalPath, proxyPath: '/no', thumbnailPath: '/no', originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '',
    createdAt: new Date(0).toISOString(), status: 'ready',
  };
}

describe('style pipeline', () => {
  let database: EditifyDatabase;
  beforeEach(() => { database = createDatabase(':memory:'); });
  afterEach(() => { database.close(); });

  it('measures, watches, aggregates, and distills in order', async () => {
    const stages: PipelineProgress[] = [];
    const distill = vi.fn(async () => 'a brief');
    const result = await runStylePipeline({
      videos: [asset('a'), asset('b', 'slow.mp4')], analyzer: mockVideoAnalyzer, distill, onProgress: (progress) => stages.push(progress),
    });
    expect(stages.map((progress) => progress.stage)).toEqual([
      'measuring', 'measuring', 'measuring', 'watching', 'watching', 'watching', 'aggregating', 'distilling',
    ]);
    expect(result.analyzer).toBe('mock');
    expect(result.metrics.map((metric) => metric.averageShotLength)).toEqual([1.5, 5]);
    expect(result.observations.every((observation) => observation.watched)).toBe(true);
    expect(result.template).toMatchObject({
      videoCount: 2, watchedCount: 2, analyzers: ['mock'], format: '9:16',
      pacing: { averageShotSeconds: 3.25, rhythm: 'fast-punch' },
      captions: { presentRatio: 1, position: 'center' },
      audio: { loudnessLufs: -12, music: 'trap beat under voice' },
    });
    expect(result.template.tags[0]).toEqual({ tag: 'bold captions', count: 2 });
    expect(distill).toHaveBeenCalledWith(result.template, result.observations);
    expect(result.styleDoc).toBe('a brief');
  });

  it('falls back to a local description when distilling fails or is absent', async () => {
    const failing = await runStylePipeline({ videos: [asset('a')], analyzer: ffmpegAnalyzer, distill: async () => { throw new Error('no model'); } });
    expect(failing.styleDoc).toMatch(/Fast-punch pacing at about 1\.5s per shot/);
    expect(failing.styleDoc).toMatch(/no video was watched/);
    expect(failing.template.watchedCount).toBe(0);
    const none = await runStylePipeline({ videos: [asset('a')], analyzer: mockVideoAnalyzer });
    expect(none.styleDoc).toMatch(/1 of 1 videos watched by mock/);
  });

  it('reuses cached observations per analyzer version and refreshes on demand', async () => {
    const cache = new ObservationCache(database);
    const watch = vi.fn(async () => ({ watched: true, summary: 'seen', tags: ['x'] }));
    const analyzer: VideoAnalyzer = { id: 'spy', label: 'spy', version: '1', watches: true, availability: () => ({ available: true, detail: '' }), analyzeVideo: watch };
    const videos = [asset('a'), asset('b')];
    await runStylePipeline({ videos, analyzer, cache });
    await runStylePipeline({ videos, analyzer, cache });
    expect(watch).toHaveBeenCalledTimes(2);
    await runStylePipeline({ videos, analyzer, cache, refresh: true });
    expect(watch).toHaveBeenCalledTimes(4);
    await runStylePipeline({ videos, analyzer: { ...analyzer, version: '2' }, cache });
    expect(watch).toHaveBeenCalledTimes(6);
    // A cached row still carries the ffmpeg numbers the model left blank.
    expect(cache.get('a', 'spy', '2')).toMatchObject({ pacing: { averageShotSeconds: 1.5, cutCount: 5 }, audio: { loudnessLufs: -12 }, tags: ['x'] });
    cache.forget('a');
    expect(cache.get('a', 'spy', '2')).toBeUndefined();
  });

  it('chains a series of functions into one analyzer', async () => {
    const chain = composeAnalyzer({
      id: 'chain', label: 'Local chain', watches: true,
      steps: [
        ({ metrics }) => ({ pacing: { rhythm: metrics.averageShotLength < 2 ? 'fast-punch' : 'slow-burn' }, tags: ['step1'] }),
        async (_input, draft) => ({ captions: { present: true, position: 'bottom' }, summary: `after ${draft.tags?.join(',')}`, tags: ['step2'] }),
        () => ({ pacing: { notes: 'kept rhythm' }, tags: ['step1'] }),
      ],
    });
    const output = await chain.analyzeVideo({
      assetId: 'a', path: '/x', mimeType: 'video/mp4', durationSeconds: 10, width: 1080, height: 1920, hasAudio: true,
      metrics: { assetId: 'a', duration: 10, cutCount: 5, cutDensity: 0.5, averageShotLength: 1.5, loudnessLufs: -12, width: 1080, height: 1920, format: '9:16' },
    });
    expect(output).toEqual({
      tags: ['step1', 'step2'], pacing: { rhythm: 'fast-punch', notes: 'kept rhythm' },
      captions: { present: true, position: 'bottom' }, summary: 'after step1',
    });
    expect(await chain.availability()).toEqual({ available: true, detail: '3 local steps' });
    await expect(composeAnalyzer({ id: 'bad', label: 'bad', steps: [() => ({ captions: { position: 'sideways' } } as never)] })
      .analyzeVideo({} as never)).rejects.toThrow();
  });

  it('builds a template that survives partial and legacy rows', () => {
    const template = buildStyleTemplate([
      { assetId: 'a', analyzer: 'ffmpeg', watched: false, durationSeconds: 8, format: '9:16', summary: '', tags: [], pacing: { averageShotSeconds: 1, cutCount: 8 } },
      { assetId: 'b', analyzer: 'gemini', watched: true, durationSeconds: 12, format: '16:9', summary: '', tags: ['A', 'b'], pacing: { averageShotSeconds: 3, cutCount: 4 }, captions: { present: false } },
      { assetId: 'c', analyzer: 'gemini', watched: true, durationSeconds: 20, format: '9:16', summary: '', tags: ['a'], transitions: { dominant: 'whip pan' } },
    ]);
    expect(template).toMatchObject({
      videoCount: 3, watchedCount: 2, analyzers: ['ffmpeg', 'gemini'], format: '9:16',
      durationSeconds: { median: 12, min: 8, max: 20 },
      pacing: { averageShotSeconds: 2, cutDensity: 0.667, rhythm: null },
      captions: { presentRatio: 0, position: null }, transitions: { dominant: 'whip pan', frequency: null },
      tags: [{ tag: 'a', count: 2 }, { tag: 'b', count: 1 }],
    });
    expect(describeTemplate(template)).toMatch(/whip pan transitions/);
    expect(() => buildStyleTemplate([])).toThrow();
  });
});

describe('style analyzer registry', () => {
  let database: EditifyDatabase;
  let settings: SettingsStore;
  beforeEach(() => { database = createDatabase(':memory:'); settings = new SettingsStore(database); });
  afterEach(() => { database.close(); });

  it('defaults to ffmpeg with nothing configured and lists the rest as unavailable', async () => {
    const registry = new StyleAnalyzerRegistry(settings, undefined, {});
    const status = await registry.status();
    expect(status.active).toBe('ffmpeg');
    expect(status.options.map((option) => [option.id, option.available])).toEqual([['gemini', false], ['webhook', false], ['ffmpeg', true]]);
    expect(status.options.find((option) => option.id === 'gemini')?.detail).toMatch(/GEMINI_API_KEY/);
    await expect(registry.select('gemini')).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it('prefers a keyed Gemini, then the env choice, then the stored choice', async () => {
    const env = { GEMINI_API_KEY: 'k', EDITIFY_STYLE_ANALYZER_URL: 'https://svc.example' };
    const { builtInAnalyzers } = await import('../src/style/registry.js');
    expect((await new StyleAnalyzerRegistry(settings, builtInAnalyzers(env), env).status()).active).toBe('gemini');
    const withEnv = { ...env, EDITIFY_STYLE_ANALYZER: 'webhook' };
    const registry = new StyleAnalyzerRegistry(settings, builtInAnalyzers(withEnv), withEnv);
    expect((await registry.status()).active).toBe('webhook');
    await registry.select('ffmpeg');
    expect(settings.get(ANALYZER_SETTING_KEY)).toBe('ffmpeg');
    expect((await registry.status()).active).toBe('ffmpeg');
  });

  it('accepts a custom analyzer and flags a stored choice that stopped working', async () => {
    settings.set(ANALYZER_SETTING_KEY, 'gone');
    const registry = new StyleAnalyzerRegistry(settings, [ffmpegAnalyzer], {}).register(mockVideoAnalyzer);
    const status = await registry.status();
    expect(status).toMatchObject({ active: 'ffmpeg', requested: 'gone' });
    expect(status.options.map((option) => option.id)).toEqual(['ffmpeg', 'mock']);
    await registry.select('mock');
    expect((await registry.resolve()).id).toBe('mock');
  });
});

const input = () => ({
  assetId: 'a', path: asset('g').originalPath, mimeType: 'video/mp4', durationSeconds: 10, width: 1080, height: 1920, hasAudio: true,
  metrics: { assetId: 'a', duration: 10, cutCount: 5, cutDensity: 0.5, averageShotLength: 1.5, loudnessLufs: -12, width: 1080, height: 1920, format: '9:16' },
});

describe('Gemini analyzer', () => {
  it('uploads, waits for processing, asks for JSON, and deletes the file', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      calls.push({ url: address, method: init?.method ?? 'GET' });
      if (address.includes('/upload/v1beta/files') && init?.headers && (init.headers as Record<string, string>)['X-Goog-Upload-Command'] === 'start') {
        return new Response(null, { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/session' } });
      }
      if (address === 'https://upload.example/session') {
        return Response.json({ file: { name: 'files/abc', uri: 'https://files.example/abc', state: 'PROCESSING', mimeType: 'video/mp4' } });
      }
      if (address.includes('/v1beta/files/abc') && (init?.method ?? 'GET') === 'GET') {
        polls += 1;
        return Response.json({ name: 'files/abc', uri: 'https://files.example/abc', state: polls < 2 ? 'PROCESSING' : 'ACTIVE', mimeType: 'video/mp4' });
      }
      if (address.includes(':generateContent')) {
        const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<Record<string, unknown>> }>; generationConfig: Record<string, unknown> };
        expect(body.contents[0]?.parts[0]).toEqual({ file_data: { mime_type: 'video/mp4', file_uri: 'https://files.example/abc' } });
        expect(body.generationConfig.response_mime_type).toBe('application/json');
        const answer = { summary: 'Loud talking head.', captions: { present: true, position: 'center' }, tags: ['loud'], hook: { technique: 'question' } };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      throw new Error(`unexpected ${address}`);
    });
    const analyzer = new GeminiVideoAnalyzer({ apiKey: 'secret', fetchImpl: fetchImpl as unknown as typeof fetch, pollIntervalMs: 1 });
    const output = await analyzer.analyzeVideo(input());
    expect(output).toMatchObject({ watched: true, summary: 'Loud talking head.', captions: { present: true, position: 'center' }, tags: ['loud'] });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'GET', 'GET', 'POST', 'DELETE']);
    expect(calls.every((call) => !call.url.includes('upload.example') ? call.url.includes('key=secret') : true)).toBe(true);
    expect(analyzer.availability()).toMatchObject({ available: true });
  });

  it('surfaces a failed processing state and still cleans up', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      if ((init?.headers as Record<string, string> | undefined)?.['X-Goog-Upload-Command'] === 'start') {
        return new Response(null, { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/session' } });
      }
      if (address === 'https://upload.example/session') return Response.json({ file: { name: 'files/abc', uri: 'u', state: 'FAILED', error: { message: 'unsupported codec' } } });
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      throw new Error(`unexpected ${address}`);
    });
    const analyzer = new GeminiVideoAnalyzer({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, pollIntervalMs: 1 });
    await expect(analyzer.analyzeVideo(input())).rejects.toThrow(/unsupported codec/);
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });
});

describe('webhook analyzer', () => {
  it('posts the video plus metadata as multipart and parses the reply', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://svc.example/analyze');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
      const form = init?.body as FormData;
      expect(JSON.parse(String(form.get('input')))).toMatchObject({ assetId: 'a', metrics: { cutCount: 5 } });
      expect(JSON.parse(String(form.get('input')))).not.toHaveProperty('path');
      const video = form.get('video') as File;
      expect(video.type).toBe('video/mp4');
      expect(await video.text()).toBe('not really a video');
      return Response.json({ summary: 'From the service', transitions: { dominant: 'zoom' }, tags: ['svc'] });
    });
    const analyzer = new WebhookVideoAnalyzer({ url: 'https://svc.example/analyze', token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await analyzer.analyzeVideo(input())).toMatchObject({ watched: true, summary: 'From the service', transitions: { dominant: 'zoom' }, tags: ['svc'] });
  });

  it('rejects a malformed reply and a failing service', async () => {
    const bad = new WebhookVideoAnalyzer({ url: 'https://svc.example', fetchImpl: (async () => Response.json({ captions: { position: 'left' } })) as unknown as typeof fetch });
    await expect(bad.analyzeVideo(input())).rejects.toThrow();
    const down = new WebhookVideoAnalyzer({ url: 'https://svc.example', fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch });
    await expect(down.analyzeVideo(input())).rejects.toThrow(/503/);
    expect(new WebhookVideoAnalyzer({ url: '' }).availability()).toMatchObject({ available: false });
  });
});
