import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PROPOSAL_OPS,
  projectHash,
  projectSchema,
  proposalSchema,
  verifyProposal,
  type AgentTurnRequest,
  type AnalysisBundle,
  type Project,
  type Proposal,
} from '@editify/shared';
import { buildApp } from '../src/app.js';
import { AnthropicToolProvider, anthropicRequestBody, type ToolProvider } from '../src/agent/providers.js';
import { AgentService } from '../src/agent/service.js';
import { runSnapshotTurn } from '../src/agent/snapshot-context.js';
import { createToolRegistry } from '../src/agent/tools.js';
import { createDatabase } from '../src/db/database.js';
import { registerAgentTurnRoutes, type AgentTurnOptions } from '../src/routes/agent-turn.js';

const PROPOSAL_ID = 'proposal-0001';

const snapshotProject: Project = projectSchema.parse({
  id: 'phone-project',
  title: 'Stand-up set',
  format: '9:16',
  fps: 30,
  duration: 10,
  version: 7,
  tracks: [
    { id: 'video-main', kind: 'video', clips: [{ id: 'clip-1', assetId: 'asset-1', start: 0, in: 0, out: 10 }] },
    { id: 'audio-main', kind: 'audio', clips: [] },
    { id: 'captions', kind: 'caption', clips: [] },
  ],
});

const snapshotAssets = [{ id: 'asset-1', originalName: 'IMG_9267.MOV', duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true }];

function words(count: number, spacing = 0.5): Array<{ w: string; s: number; e: number }> {
  return Array.from({ length: count }, (_unused, index) => ({ w: `word${index}`, s: index * spacing, e: index * spacing + spacing * 0.8 }));
}

function bundleWith(wordCount = 8): AnalysisBundle {
  const spoken = words(wordCount);
  return {
    assets: {
      'asset-1': {
        transcript: {
          status: 'ready',
          analyzerVersion: 'speech-analyzer-26',
          data: {
            language: 'en',
            durationProcessedSeconds: 10,
            words: spoken,
            segments: [{ text: spoken.map((word) => word.w).join(' '), s: 0, e: spoken.at(-1)?.e ?? 1 }],
          },
        },
        energy: { status: 'pending', analyzerVersion: 'onset-1' },
      },
    },
    syncs: [],
  };
}

function turnRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    message: 'tighten this',
    proposalId: PROPOSAL_ID,
    snapshot: { project: snapshotProject, assets: snapshotAssets },
    bundle: bundleWith(),
    ...overrides,
  };
}

type ScriptedTurn = { text?: string; toolCalls?: Array<{ name: string; input: unknown }> };

/** Plays `turns` in order and records what each model call was offered. */
function scriptedProvider(turns: ScriptedTurn[]): ToolProvider & { offered: string[][] } {
  let index = 0;
  const offered: string[][] = [];
  return {
    name: 'mock',
    offered,
    async runTurn(_system, _messages, toolDefs) {
      offered.push(toolDefs.map((tool) => tool.name));
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return {
        ...(turn?.text ? { text: turn.text } : {}),
        toolCalls: (turn?.toolCalls ?? []).map((call, i) => ({ id: `t${index}-${i}`, ...call })),
      };
    },
    async completeText() { return ''; },
  };
}

async function turnApp(provider: ToolProvider, options: AgentTurnOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    const user = request.headers['x-user'];
    if (typeof user === 'string') request.userId = user;
  });
  registerAgentTurnRoutes(app, new AgentService(async () => provider), options);
  await app.ready();
  return app;
}

async function post(app: FastifyInstance, payload: unknown, user = 'alice') {
  return await app.inject({ method: 'POST', url: '/agent/turn', headers: { 'x-user': user }, payload: payload as Record<string, unknown> });
}

describe('stateless agent turn: proposals', () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, noAuth: process.env.EDITIFY_NO_AUTH };
  afterEach(() => {
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['EDITIFY_NO_AUTH', saved.noAuth]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('answers POST /agent/turn with a proposal and writes nothing to the server tables', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.EDITIFY_NO_AUTH = '1';
    const database = createDatabase(':memory:');
    const app = await buildApp({ database });
    try {
      const response = await app.inject({
        method: 'POST', url: '/agent/turn', payload: turnRequest({ message: 'add bold captions' }) as unknown as Record<string, unknown>,
      });
      expect(response.statusCode).toBe(200);
      const proposal = proposalSchema.parse(response.json().proposal);
      expect(proposal.status).toBe('proposed');
      expect(proposal.baseRevision).toBe(7);
      expect(proposal.ops.some((op) => op.type === 'add_caption')).toBe(true);
      expect(verifyProposal(snapshotProject, proposal).ok).toBe(true);
      // The turn's own body limit holds through the app's JSON parser too.
      const oversized = await app.inject({ method: 'POST', url: '/agent/turn', payload: { ...turnRequest(), message: 'x'.repeat(9 * 1024 * 1024) } });
      expect(oversized.statusCode).toBe(413);
      for (const table of ['projects', 'operation_log', 'project_assets', 'assets', 'transcripts', 'chat_messages']) {
        expect((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, table).toBe(0);
      }
    } finally {
      await app.close();
    }
  });

  it('writes generated split ids into the ops, so the phone replays to the same hash', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'split_clips', input: { cuts: [{ clipId: 'clip-1', at: 6 }, { clipId: 'clip-1', at: 3 }] } }] },
      { toolCalls: [{ name: 'remove_words', input: { matches: ['word1'] } }] },
      { text: 'Split the clip and cut a word.' },
    ]);
    const proposal = await runSnapshotTurn(provider, turnRequest(), bundleWith());
    const splits = proposal.ops.filter((op) => op.type === 'split_clip');
    expect(splits.map((op) => op.type === 'split_clip' && op.params.newClipId)).toEqual([`${PROPOSAL_ID}-s1`, `${PROPOSAL_ID}-s2`]);
    expect(proposal.ops.some((op) => op.type === 'ripple_delete_ranges')).toBe(true);

    // Through JSON, as it reaches the phone.
    const received = proposalSchema.parse(JSON.parse(JSON.stringify(proposal)));
    const check = verifyProposal(snapshotProject, received);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(projectHash(check.project)).toBe(proposal.expectedHash);
    expect(check.project.version).toBe(8);
    expect(check.project.tracks[0]?.clips.map((clip) => clip.id)).toEqual(expect.arrayContaining([`${PROPOSAL_ID}-s1`, `${PROPOSAL_ID}-s2`]));
  });

  it('rejects a proposal for a stale revision, a tampered op, or ops that no longer apply', async () => {
    const proposal = await runSnapshotTurn(scriptedProvider([
      { toolCalls: [{ name: 'split_clip', input: { clipId: 'clip-1', at: 4 } }] },
      { text: 'Split at 4s.' },
    ]), turnRequest(), bundleWith());
    expect(verifyProposal(snapshotProject, proposal).ok).toBe(true);

    expect(verifyProposal({ ...snapshotProject, version: 8 }, proposal)).toEqual({ ok: false, reason: 'stale' });
    const tampered: Proposal = { ...proposal, ops: proposal.ops.map((op) => (op.type === 'split_clip' ? { ...op, params: { ...op.params, at: 5 } } : op)) };
    expect(verifyProposal(snapshotProject, tampered)).toEqual({ ok: false, reason: 'mismatch' });
    const unnamed: Proposal = { ...proposal, ops: [{ type: 'split_clip', params: { clipId: 'clip-1', at: 4 } }] };
    expect(verifyProposal(snapshotProject, unnamed)).toEqual({ ok: false, reason: 'invalid' });
    const elsewhere = { ...snapshotProject, tracks: snapshotProject.tracks.map((track) => ({ ...track, clips: [] })) };
    expect(verifyProposal(elsewhere, proposal)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('turns undo into a device command instead of applying it, and refuses edits after it', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'undo', input: {} }] },
      { toolCalls: [{ name: 'split_clip', input: { clipId: 'clip-1', at: 4 } }] },
      { text: 'I asked your phone to undo the last edit.' },
    ]);
    const proposal = await runSnapshotTurn(provider, turnRequest(), bundleWith());
    expect(proposal.deviceCommands).toEqual([{ type: 'undo', params: {} }]);
    expect(proposal.ops).toEqual([]);
    expect(proposal.expectedHash).toBe(projectHash(snapshotProject));
    expect(proposal.trace[0]).toMatchObject({ tool: 'undo', ok: true, summary: 'Proposed undo to the phone; nothing was applied here.' });
    expect(proposal.trace[1]).toMatchObject({ tool: 'split_clip', ok: false });
  });

  it('verifies a zero-op proposal against a device document that is not in schema shape', async () => {
    const proposal = await runSnapshotTurn(scriptedProvider([
      { toolCalls: [{ name: 'undo', input: {} }] },
      { text: 'Asked the phone to undo.' },
    ]), turnRequest(), bundleWith());
    expect(proposal.ops).toEqual([]);
    // What the phone holds: a local-only key, a default left out, a stale duration.
    const { fps: _fps, ...withoutFps } = snapshotProject;
    const deviceProject = { ...withoutFps, duration: 3, localDraft: true } as unknown as Project;
    const check = verifyProposal(deviceProject, proposal);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.project.version).toBe(7);
  });

  it('judges a music bed from the bundle\'s loudness and names clips it could not measure', async () => {
    const flat = (db: number, seconds: number) => ({ cellSeconds: 0.05 as const, rmsDb: Array.from({ length: seconds * 20 }, () => db) });
    const project = projectSchema.parse({
      ...snapshotProject,
      tracks: snapshotProject.tracks.map((track) => (track.kind === 'audio'
        ? { ...track, clips: [{ id: 'bed', assetId: 'bed-asset', start: 0, in: 0, out: 10 }, { id: 'hit', assetId: 'hit-asset', start: 2, in: 0, out: 1 }] }
        : track)),
    });
    const bundle = bundleWith();
    const withEnergy: AnalysisBundle = {
      ...bundle,
      assets: {
        'asset-1': { ...bundle.assets['asset-1'], energy: { status: 'ready', analyzerVersion: 'onset-1', data: flat(-20, 10) } },
        // A bed has no words, only loudness; the hit has nothing yet.
        'bed-asset': { energy: { status: 'ready', analyzerVersion: 'onset-1', data: flat(-10, 10) } },
        'hit-asset': { energy: { status: 'pending', analyzerVersion: 'onset-1' } },
      },
    };
    let mixResult: { beds?: Array<{ clipId: string }>; unmeasured?: string[]; warnings?: string[] } = {};
    const provider: ToolProvider = {
      name: 'mock',
      async runTurn(_system, messages) {
        const result = messages.find((message) => message.role === 'tool' && message.name === 'check_mix');
        if (result?.role === 'tool') {
          mixResult = JSON.parse(result.content) as typeof mixResult;
          return { text: 'Checked the mix.', toolCalls: [] };
        }
        return { toolCalls: [{ id: 'mix', name: 'check_mix', input: {} }] };
      },
      async completeText() { return ''; },
    };
    const extra = (id: string, duration: number) => ({ id, originalName: `${id}.m4a`, duration, width: 0, height: 0, fps: 0, hasAudio: true });
    await runSnapshotTurn(provider, turnRequest({
      snapshot: { project, assets: [...snapshotAssets, extra('bed-asset', 10), extra('hit-asset', 1)] },
    }), withEnergy);
    expect(mixResult.beds?.map((bed) => bed.clipId)).toEqual(['bed']);
    expect(mixResult.unmeasured).toEqual(['hit']);
    expect(mixResult.warnings?.some((line) => line.includes('no loudness measurement') && line.includes('hit'))).toBe(true);
  });

  it('accepts one AI action of more than 100 ops (a caption per word over 200 words)', async () => {
    const bundle = bundleWith(200);
    const project = projectSchema.parse({
      ...snapshotProject,
      duration: 100,
      tracks: snapshotProject.tracks.map((track) => (track.kind === 'video'
        ? { ...track, clips: [{ id: 'clip-1', assetId: 'asset-1', start: 0, in: 0, out: 100 }] } : track)),
    });
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'caption_clip_from_transcript', input: { clipId: 'clip-1', wordsPerChunk: 1 } }] },
      { text: 'Captioned every word.' },
    ]);
    const proposal = await runSnapshotTurn(provider, turnRequest({
      snapshot: { project, assets: [{ ...snapshotAssets[0]!, duration: 100 }] },
    }), bundle);
    expect(proposal.ops.length).toBeGreaterThan(100);
    expect(proposal.ops.length).toBeLessThanOrEqual(MAX_PROPOSAL_OPS);
    expect(verifyProposal(project, proposal).ok).toBe(true);
  });

  it('offers only what the snapshot can serve, and never runs Whisper for a missing transcript', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'caption_clip_from_transcript', input: { clipId: 'clip-1' } }] },
      { text: 'Could not caption yet.' },
    ]);
    const bundle = bundleWith();
    const pending: AnalysisBundle = {
      ...bundle,
      assets: { 'asset-1': { transcript: { status: 'pending', analyzerVersion: 'speech-analyzer-26' } } },
    };
    await runSnapshotTurn(provider, turnRequest({ bundle: pending }), pending);
    const offered = new Set(provider.offered[0]);
    for (const name of ['dissect_asset', 'cut_to_beats', 'apply_style_packet', 'get_insights', 'get_render_qa', 'sync_audio', 'check_mix', 'get_transcript', 'caption_clip_from_transcript']) {
      expect(offered.has(name), name).toBe(false);
    }
    for (const name of ['get_project', 'list_assets', 'split_clip', 'undo', 'place_captions']) expect(offered.has(name), name).toBe(true);

    // With the words ready the transcript tools come back; the media-bound ones stay out.
    const ready = scriptedProvider([{ text: 'Looked.' }]);
    await runSnapshotTurn(ready, turnRequest(), bundle);
    expect(ready.offered[0]).toContain('caption_clip_from_transcript');
    expect(ready.offered[0]).not.toContain('apply_style_packet');
    expect(ready.offered[0]).not.toContain('remove_silence');
  });

  it('reports a transcript the phone has not finished instead of transcribing on the server', async () => {
    const project = projectSchema.parse({
      ...snapshotProject,
      tracks: snapshotProject.tracks.map((track) => (track.kind === 'video'
        ? { ...track, clips: [...track.clips, { id: 'clip-2', assetId: 'asset-2', start: 10, in: 0, out: 5 }] } : track)),
    });
    const bundle = bundleWith();
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'caption_clip_from_transcript', input: { clipId: 'clip-2' } }] },
      { text: 'The second clip has no words yet.' },
    ]);
    const proposal = await runSnapshotTurn(provider, turnRequest({
      snapshot: { project, assets: [...snapshotAssets, { ...snapshotAssets[0]!, id: 'asset-2', duration: 5 }] },
    }), { ...bundle, assets: { ...bundle.assets, 'asset-2': { transcript: { status: 'pending', analyzerVersion: 'speech-analyzer-26' } } } });
    expect(proposal.trace[0]).toMatchObject({ tool: 'caption_clip_from_transcript', ok: false });
    expect(proposal.trace[0]?.summary).toContain('not available in a stateless turn');
    expect(proposal.ops).toEqual([]);
  });

  it('plans a sync from the phone\'s pairwise measurement without decoding anything', async () => {
    const project = projectSchema.parse({
      ...snapshotProject,
      tracks: snapshotProject.tracks.map((track) => (track.kind === 'audio'
        ? { ...track, clips: [{ id: 'memo', assetId: 'memo-asset', start: 0, in: 0, out: 9 }] } : track)),
    });
    const bundle: AnalysisBundle = {
      ...bundleWith(),
      syncs: [{
        videoAssetId: 'asset-1', memoAssetId: 'memo-asset', status: 'ready', analyzerVersion: 'audio-sync-1',
        measurement: { lag: 0.5, anchor: 5, rate: 1, coarseRatio: 9, fineScore: 12, confident: true, overlapSec: 9, windows: [] },
      }],
    };
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'sync_audio', input: { audioClipId: 'memo' } }] },
      { text: 'Synced the memo.' },
    ]);
    const proposal = await runSnapshotTurn(provider, turnRequest({
      snapshot: { project, assets: [...snapshotAssets, { id: 'memo-asset', originalName: 'memo.m4a', duration: 9, width: 0, height: 0, fps: 0, hasAudio: true }] },
    }), bundle);
    expect(proposal.trace[0]).toMatchObject({ tool: 'sync_audio', ok: true });
    expect(proposal.ops.length).toBeGreaterThan(0);
    const check = verifyProposal(project, proposal);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.project.tracks.find((track) => track.kind === 'audio')?.clips[0]?.start).toBe(0.5);
  });
});

describe('POST /agent/turn transport', () => {
  it('holds an inline bundle by digest, serves a digest-only turn from it, and asks again for an unknown one', async () => {
    const provider = scriptedProvider([{ text: 'Looked.' }]);
    const app = await turnApp(provider);
    const first = await post(app, turnRequest());
    expect(first.statusCode).toBe(200);
    const digest = first.json().bundleDigest as string;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const { bundle: _bundle, ...withoutBundle } = turnRequest({ proposalId: 'proposal-0002' });
    const second = await post(app, { ...withoutBundle, bundleDigest: digest });
    expect(second.statusCode).toBe(200);
    expect(provider.offered.at(-1)).toContain('get_transcript');

    const unknown = await post(app, { ...withoutBundle, proposalId: 'proposal-0003', bundleDigest: 'f'.repeat(64) });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ needBundle: true });
    // Digests are per user: Bob cannot reach Alice's analysis by its digest.
    const bob = await post(app, { ...withoutBundle, proposalId: 'proposal-0004', bundleDigest: digest }, 'bob');
    expect(bob.statusCode).toBe(409);
    await app.close();
  });

  it('lets a failed turn be retried: the idempotency record and the project lock are both released', async () => {
    let fail = true;
    let calls = 0;
    const provider: ToolProvider = {
      name: 'mock',
      async runTurn() {
        calls += 1;
        if (fail) throw new Error('Anthropic is unavailable right now (500). Try again in a moment.');
        return { text: 'Looked.', toolCalls: [] };
      },
      async completeText() { return ''; },
    };
    const app = await turnApp(provider);
    expect((await post(app, turnRequest())).statusCode).toBe(500);
    fail = false;
    const retry = await post(app, turnRequest());
    expect(retry.statusCode).toBe(200);
    expect(calls).toBe(2);
    expect((await post(app, turnRequest({ proposalId: 'proposal-0002' }))).statusCode).toBe(200);
    await app.close();
  });

  it('refuses a body over the turn\'s own limit', async () => {
    const app = await turnApp(scriptedProvider([{ text: 'Looked.' }]));
    const response = await post(app, { ...turnRequest(), message: 'x'.repeat(9 * 1024 * 1024) });
    expect(response.statusCode).toBe(413);
    await app.close();
  });

  it('caches a bundle only for a turn that runs, and at most a few per user', async () => {
    const app = await turnApp(scriptedProvider([{ text: 'Looked.' }]), { rate: { capacity: 6, refillPerSecond: 0.001 } });
    const digests: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await post(app, turnRequest({ proposalId: `proposal-000${index}`, bundle: bundleWith(index + 2) }));
      expect(response.statusCode).toBe(200);
      digests.push(response.json().bundleDigest as string);
    }
    const { bundle: _bundle, ...withoutBundle } = turnRequest();
    // Five bundles from one user: the oldest made way, the newest is still there.
    expect((await post(app, { ...withoutBundle, proposalId: 'proposal-0100', bundleDigest: digests[0] })).json()).toMatchObject({ needBundle: true });
    expect((await post(app, { ...withoutBundle, proposalId: 'proposal-0101', bundleDigest: digests[4] })).statusCode).toBe(200);

    // The allowance is spent: a refused turn's inline bundle is not kept.
    const refused = await post(app, turnRequest({ proposalId: 'proposal-0102', bundle: bundleWith(20) }));
    expect(refused.statusCode).toBe(429);
    const fresh = await turnApp(scriptedProvider([{ text: 'Looked.' }]));
    const digest = (await post(fresh, turnRequest({ bundle: bundleWith(20) }))).json().bundleDigest as string;
    await fresh.close();
    expect((await post(app, { ...withoutBundle, proposalId: 'proposal-0103', bundleDigest: digest })).json()).toMatchObject({ needBundle: true });
    await app.close();
  });

  it('answers a repeated proposalId with the same proposal without running the model again', async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'split_clip', input: { clipId: 'clip-1', at: 4 } }] },
      { text: 'Split at 4s.' },
    ]);
    const app = await turnApp(provider);
    const first = await post(app, turnRequest());
    const calls = provider.offered.length;
    const again = await post(app, turnRequest());
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(provider.offered.length).toBe(calls);
    await app.close();
  });

  it('allows one turn per project at a time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const provider: ToolProvider = {
      name: 'mock',
      async runTurn() { started(); await gate; return { text: 'Done.', toolCalls: [] }; },
      async completeText() { return ''; },
    };
    const app = await turnApp(provider);
    const first = post(app, turnRequest());
    await running;
    const second = await post(app, turnRequest({ proposalId: 'proposal-0002' }));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'busy' });
    // Another project of the same user is not blocked by it.
    const other = post(app, turnRequest({ proposalId: 'proposal-0003', snapshot: { project: { ...snapshotProject, id: 'other-project' }, assets: snapshotAssets } }));
    release();
    expect((await first).statusCode).toBe(200);
    expect((await other).statusCode).toBe(200);
    // Released: the next turn on the first project runs.
    expect((await post(app, turnRequest({ proposalId: 'proposal-0004' }))).statusCode).toBe(200);
    await app.close();
  });

  it('rate-limits a user with 429 and Retry-After, without touching other users', async () => {
    const app = await turnApp(scriptedProvider([{ text: 'Looked.' }]), { rate: { capacity: 2, refillPerSecond: 0.05 } });
    expect((await post(app, turnRequest({ proposalId: 'proposal-0001' }))).statusCode).toBe(200);
    expect((await post(app, turnRequest({ proposalId: 'proposal-0002' }))).statusCode).toBe(200);
    const limited = await post(app, turnRequest({ proposalId: 'proposal-0003' }));
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await post(app, turnRequest({ proposalId: 'proposal-0004' }), 'bob')).statusCode).toBe(200);
    await app.close();
  });
});

describe('prompt caching', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('marks the system prompt and the last tool definition as cache breakpoints', async () => {
    const tools = createToolRegistry().slice(0, 3);
    const body = anthropicRequestBody('You are Editify.', [{ role: 'user', content: 'hi' }], tools) as {
      system: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>>;
    };
    expect(body.system).toEqual([{ type: 'text', text: 'You are Editify.', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools.map((tool) => tool.cache_control)).toEqual([undefined, undefined, { type: 'ephemeral' }]);

    // And it is what goes over the wire.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })));
    globalThis.fetch = fetchMock as typeof fetch;
    await new AnthropicToolProvider('key').runTurn('You are Editify.', [{ role: 'user', content: 'hi' }], tools);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as typeof body;
    expect(sent.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
  });
});
