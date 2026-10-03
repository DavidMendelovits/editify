import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectHash, renderSnapshot, type Project, type RenderSnapshot } from '@editify/shared';

/*
 * The server fallback (plan OV1): POST /projects/:id/render with a snapshot renders the
 * document the phone sent, at its revision and hash, never whatever the server holds when
 * the job starts; POST /projects/:id/assets/availability says which originals the server
 * has; PUT /assets/:id/original puts a missing one back under its own id.
 */
vi.hoisted(() => { process.env.EDITIFY_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/editify-render-snapshot-${process.pid}`; });
const calls = vi.hoisted(() => ({
  legacy: [] as Array<{ project: Project; renderId: string }>,
  plan: [] as unknown[][],
  /** Holds the first legacy render until released, so a second job waits in the queue. */
  gate: null as Promise<void> | null,
}));
vi.mock('../src/media/render.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/media/render.js')>()),
  renderProject: async (project: Project, _resolution: unknown, renderId: string) => {
    calls.legacy.push({ project, renderId });
    if (calls.gate) await calls.gate;
    return `/renders/${renderId}/output.mp4`;
  },
}));
vi.mock('../src/media/plan/render.js', () => ({
  renderPlan: async (...args: unknown[]) => {
    calls.plan.push(args);
    const out = args[2] as { outputPath: string };
    return { outputPath: out.outputPath, frames: 30, notes: [], loudness: { measuredLufs: null, truePeakDb: null, decision: { gainDb: 0, limit: false } }, elapsed: 1 };
  },
}));
vi.mock('../src/media/plan/media.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/media/plan/media.js')>()),
  probePlanMedia: async (path: string, kind: string) => ({
    path, info: { kind, width: 1080, height: 1920, duration: 10, hasAudio: true, fps: 30 },
    color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' }, orientation: 1, hasVideo: true, audioChannels: 2, audioLayout: 'stereo',
  }),
}));
vi.mock('../src/services/render-qa.js', () => ({ runRenderQa: async () => undefined }));

const { buildApp } = await import('../src/app.js');
const { AssetStore } = await import('../src/db/asset-store.js');
const { createDatabase } = await import('../src/db/database.js');
const { assetsRoot } = await import('../src/config.js');
const { RENDER_BODY_LIMIT } = await import('../src/routes/projects.js');

const SUPABASE = 'https://snapshot.supabase.test';
const ALICE = 'alice-snap';
const BOB = 'bob-snap';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

let app: FastifyInstance;
let assets: InstanceType<typeof AssetStore>;
let database: ReturnType<typeof createDatabase>;
const auth: Record<string, { authorization: string }> = {};
const media = mkdtempSync(join(tmpdir(), 'editify-snapshot-media-'));
const savedToken = process.env.EDITIFY_TOKEN;

async function sign(privateKey: CryptoKey, subject: string): Promise<string> {
  return await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'snapshot' })
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** An asset row; `file: false` leaves its original off disk (never uploaded, or removed). */
function addAsset(
  id: string, owner: string | undefined,
  options: { file?: boolean; duration?: number; width?: number; height?: number; hasAudio?: boolean; mimeType?: string } = {},
): void {
  const originalPath = join(media, `${id}.mp4`);
  if (options.file !== false) writeFileSync(originalPath, 'x');
  assets.insert({
    id, originalName: `${id}.mp4`, mimeType: options.mimeType ?? 'video/mp4', duration: options.duration ?? 4,
    width: options.width ?? 1080, height: options.height ?? 1920, fps: 30, hasAudio: options.hasAudio ?? true,
    originalPath, proxyPath: originalPath, thumbnailPath: originalPath,
    originalUrl: '', proxyUrl: '', thumbnailUrl: '', filmstripUrl: '', createdAt: new Date(0).toISOString(),
  }, owner);
}

async function call(user: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return await app.inject({ method, url, headers: auth[user] ?? {}, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function newProject(user: string): Promise<Project> {
  return (await call(user, 'POST', '/projects', { title: 'Snapshot' })).json<Project>();
}

/** The phone's document: the project with one video clip on `assetId` lasting `out` seconds. */
function withClip(project: Project, assetId: string, out = 2, version = project.version): Project {
  return {
    ...project,
    version,
    duration: out,
    tracks: project.tracks.map((track) => (track.kind === 'video' ? { ...track, clips: [{ id: 'clip-1', assetId, start: 0, in: 0, out }] } : track)),
  };
}

async function renderWith(user: string, projectId: string, snapshot?: RenderSnapshot, resolution = '720p') {
  return await call(user, 'POST', `/projects/${projectId}/render`, { resolution, ...(snapshot ? { snapshot } : {}) });
}

async function finished(renderId: string): Promise<{ status: string; error?: string; projectVersion?: number; snapshot?: { revision: number; hash: string } }> {
  let record = (await call(ALICE, 'GET', `/renders/${renderId}`)).json();
  await vi.waitFor(async () => {
    record = (await call(ALICE, 'GET', `/renders/${renderId}`)).json();
    expect(['done', 'error']).toContain(record.status);
  });
  return record;
}

beforeAll(async () => {
  delete process.env.EDITIFY_TOKEN;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), alg: 'ES256', kid: 'snapshot', use: 'sig' }] });
  auth[ALICE] = { authorization: `Bearer ${await sign(privateKey, ALICE)}` };
  auth[BOB] = { authorization: `Bearer ${await sign(privateKey, BOB)}` };
  database = createDatabase(':memory:');
  assets = new AssetStore(database);
  app = await buildApp({ database, auth: { supabaseUrl: SUPABASE, jwks }, databaseUrl: null });
});

beforeEach(() => {
  calls.legacy.length = 0;
  calls.plan.length = 0;
  calls.gate = null;
});
afterEach(() => { delete process.env.RENDER_PLAN; });

afterAll(async () => {
  await app.close();
  if (savedToken !== undefined) process.env.EDITIFY_TOKEN = savedToken;
  rmSync(media, { recursive: true, force: true });
  rmSync(process.env.EDITIFY_DATA_DIR as string, { recursive: true, force: true });
});

describe('POST /projects/:id/render with a snapshot', () => {
  it('renders the snapshot even when the stored project changes before the job runs', async () => {
    addAsset('snap-a', ALICE);
    addAsset('snap-b', ALICE);
    const project = await newProject(ALICE);
    await call(ALICE, 'POST', '/assets/snap-a/link', { projectId: project.id });
    await call(ALICE, 'POST', '/assets/snap-b/link', { projectId: project.id });

    // A first render holds the queue, so the snapshot render waits behind it.
    let release: () => void = () => undefined;
    calls.gate = new Promise((resolve) => { release = resolve; });
    const first = (await renderWith(ALICE, project.id)).json<{ id: string }>();
    await vi.waitFor(() => expect(calls.legacy).toHaveLength(1));

    const phone = withClip(project, 'snap-a', 2, 5);
    const snapshot = renderSnapshot(phone);
    const queued = await renderWith(ALICE, project.id, snapshot);
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ status: 'queued', projectVersion: 5, snapshot: { revision: 5, hash: snapshot.hash } });

    // Meanwhile the server's copy moves on to something else entirely.
    const stored = await call(ALICE, 'POST', `/projects/${project.id}/ops`, {
      ops: [{ type: 'add_clip', params: { trackId: 'video-main', clip: { id: 'server-only', assetId: 'snap-b', start: 0, in: 0, out: 3 } } }],
      baseVersion: project.version,
    });
    expect(stored.statusCode).toBe(200);
    release();

    const record = await finished(queued.json<{ id: string }>().id);
    expect(record).toMatchObject({ status: 'done', projectVersion: 5, snapshot: { revision: 5, hash: snapshot.hash } });
    const rendered = calls.legacy.find((entry) => entry.renderId === queued.json<{ id: string }>().id);
    expect(rendered?.project.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId))).toEqual(['snap-a']);
    expect(projectHash(rendered!.project)).toBe(snapshot.hash);
    // The render without a snapshot read the stored project, as before.
    expect((await finished(first.id)).status).toBe('done');
    expect(calls.legacy[0]!.project.tracks.flatMap((track) => track.clips)).toEqual([]);
  });

  it('builds the RenderPlan from the snapshot when RENDER_PLAN is on', async () => {
    process.env.RENDER_PLAN = '1';
    addAsset('plan-a', ALICE);
    const project = await newProject(ALICE);
    await call(ALICE, 'POST', '/assets/plan-a/link', { projectId: project.id });
    const snapshot = renderSnapshot(withClip(project, 'plan-a', 3, 9));
    const response = await renderWith(ALICE, project.id, snapshot, '1080p');
    expect(response.statusCode).toBe(202);
    expect((await finished(response.json<{ id: string }>().id)).status).toBe('done');
    const plan = calls.plan[0]![0] as { revision: number; duration: number; video: { segments: Array<{ layers: Array<{ assetRef: { id: string } }> }> } };
    expect(plan.revision).toBe(9);
    expect(plan.duration).toBe(3);
    expect(plan.video.segments.flatMap((segment) => segment.layers.map((layer) => layer.assetRef.id))).toEqual(['plan-a']);
    expect(calls.legacy).toEqual([]);
  });

  it('refuses a snapshot whose hash, revision or project does not match', async () => {
    addAsset('hash-a', ALICE);
    const project = await newProject(ALICE);
    const snapshot = renderSnapshot(withClip(project, 'hash-a'));

    const badHash = await renderWith(ALICE, project.id, { ...snapshot, hash: '0000000000000000' });
    expect(badHash.statusCode).toBe(400);
    expect(badHash.json()).toMatchObject({ code: 'hash' });

    const badRevision = await renderWith(ALICE, project.id, { ...snapshot, revision: snapshot.revision + 1 });
    expect(badRevision.json()).toMatchObject({ code: 'revision' });

    const other = await newProject(ALICE);
    const elsewhere = await renderWith(ALICE, other.id, snapshot);
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json()).toMatchObject({ code: 'project' });

    const invalid = await renderWith(ALICE, project.id, { ...snapshot, project: { ...snapshot.project, tracks: 'nope' } } as unknown as RenderSnapshot);
    expect(invalid.statusCode).toBe(400);
    expect(calls.legacy).toEqual([]);
  });

  it("refuses a document naming another account's asset, even one linked to the project", async () => {
    addAsset('bobs-clip', BOB);
    const project = await newProject(ALICE);
    assets.link(project.id, 'bobs-clip');
    const response = await renderWith(ALICE, project.id, renderSnapshot(withClip(project, 'bobs-clip')));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden', assetIds: ['bobs-clip'] });
    expect(calls.legacy).toEqual([]);
  });

  it('names the originals the server is missing instead of queueing a render that would fail', async () => {
    addAsset('gone-a', ALICE, { file: false });
    addAsset('here-a', ALICE);
    const project = await newProject(ALICE);
    const phone: Project = {
      ...withClip(project, 'here-a'),
      tracks: [...withClip(project, 'here-a').tracks, { id: 'broll', kind: 'video', clips: [
        { id: 'c2', assetId: 'gone-a', start: 0, in: 0, out: 1 },
        { id: 'c3', assetId: '7b0c6f7e-1d1e-4a52-9c39-1b1f3f0a9d11', start: 1, in: 0, out: 1 },
      ] }],
    };
    const response = await renderWith(ALICE, project.id, renderSnapshot(phone));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'missing', assetIds: ['gone-a', '7b0c6f7e-1d1e-4a52-9c39-1b1f3f0a9d11'] });
  });

  it("links the user's own asset the project never linked, so the plan render can resolve it", async () => {
    addAsset('own-unlinked', ALICE);
    const project = await newProject(ALICE);
    expect(assets.linkedOrSound(project.id, 'own-unlinked')).toBe(false);
    const response = await renderWith(ALICE, project.id, renderSnapshot(withClip(project, 'own-unlinked')));
    expect(response.statusCode).toBe(202);
    expect(assets.linkedOrSound(project.id, 'own-unlinked')).toBe(true);
    expect((await finished(response.json<{ id: string }>().id)).status).toBe('done');
  });

  it("derives the duration itself: a client's duration is never trusted", async () => {
    addAsset('dur-a', ALICE);
    const project = await newProject(ALICE);
    // Hashed honestly over a lie: no clips, but a 115-day timeline.
    const lie: Project = { ...project, duration: 1e7, tracks: project.tracks.map((track) => ({ ...track, clips: [] })) };
    const response = await renderWith(ALICE, project.id, { revision: lie.version, hash: projectHash(lie), project: lie });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'hash' });
    expect(calls.legacy).toEqual([]);
  });

  it('refuses a timeline over 4 hours and a new video overlap', async () => {
    addAsset('long-a', ALICE);
    const project = await newProject(ALICE);
    const long = await renderWith(ALICE, project.id, renderSnapshot(withClip(project, 'long-a', 4 * 3600 + 1)));
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ code: 'too_long' });
    const overlapping: Project = {
      ...project,
      tracks: project.tracks.map((track) => (track.kind === 'video'
        ? { ...track, clips: [{ id: 'x1', assetId: 'long-a', start: 0, in: 0, out: 2 }, { id: 'x2', assetId: 'long-a', start: 1, in: 0, out: 2 }] }
        : track)),
    };
    const overlap = await renderWith(ALICE, project.id, renderSnapshot(overlapping));
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json()).toMatchObject({ code: 'invalid' });
    expect(calls.legacy).toEqual([]);
  });

  it('keeps the hash and revision on a finished render but drops the stored document', async () => {
    addAsset('drop-a', ALICE);
    const project = await newProject(ALICE);
    const snapshot = renderSnapshot(withClip(project, 'drop-a', 2, 3));
    const response = await renderWith(ALICE, project.id, snapshot);
    const id = response.json<{ id: string }>().id;
    expect(await finished(id)).toMatchObject({ status: 'done', snapshot: { revision: 3, hash: snapshot.hash } });
    expect(database.prepare('SELECT snapshot_json FROM renders WHERE id = ?').get(id)).toEqual({ snapshot_json: null });
  });

  it('renders the snapshot when a stranded render is recovered after a restart', async () => {
    addAsset('recover-a', ALICE);
    addAsset('recover-b', ALICE);
    const project = await newProject(ALICE);
    assets.link(project.id, 'recover-a');
    assets.link(project.id, 'recover-b');
    const snapshot = renderSnapshot(withClip(project, 'recover-a', 2, 4));
    const { RenderStore } = await import('../src/db/render-store.js');
    const { ProjectStore } = await import('../src/db/project-store.js');
    const { RenderQueue } = await import('../src/services/render-queue.js');
    const renders = new RenderStore(database);
    const stranded = renders.create(project.id, '720p', snapshot);
    renders.update(stranded.id, 'processing');
    // The stored project moves on while the server is down.
    database.prepare('UPDATE projects SET doc_json = ? WHERE id = ?').run(JSON.stringify(withClip(project, 'recover-b', 3, 9)), project.id);
    new RenderQueue(renders, new ProjectStore(database), assets).recover();
    await vi.waitFor(() => expect(renders.get(stranded.id)?.status).toBe('done'));
    const rendered = calls.legacy.find((entry) => entry.renderId === stranded.id);
    expect(rendered?.project.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId))).toEqual(['recover-a']);
    expect(renders.get(stranded.id)?.projectVersion).toBe(4);
  });

  it('refuses a legacy render longer than 4 hours before it encodes anything', async () => {
    const { renderProject } = await vi.importActual<typeof import('../src/media/render.js')>('../src/media/render.js');
    const project = await newProject(ALICE);
    await expect(renderProject({ ...project, duration: 1e7 }, '720p', 'too-long', assets)).rejects.toThrow('longer than 4 hours');
  });

  it('caps the request body like a sync push', async () => {
    const project = await newProject(ALICE);
    const big = renderSnapshot({ ...project, title: 'x'.repeat(RENDER_BODY_LIMIT) });
    const response = await renderWith(ALICE, project.id, big);
    expect(response.statusCode).toBe(413);
  });

  it("answers Bob 404 for Alice's project, snapshot or not", async () => {
    addAsset('alice-only', ALICE);
    const project = await newProject(ALICE);
    expect((await renderWith(BOB, project.id, renderSnapshot(withClip(project, 'alice-only')))).statusCode).toBe(404);
  });
});

describe('POST /projects/:id/assets/availability', () => {
  it('reports present, missing and forbidden, the sound library readable', async () => {
    addAsset('av-here', ALICE);
    addAsset('av-gone', ALICE, { file: false });
    addAsset('av-bobs', BOB);
    addAsset('sound-av-pop', undefined);
    const project = await newProject(ALICE);
    const response = await call(ALICE, 'POST', `/projects/${project.id}/assets/availability`, {
      assetIds: ['av-here', 'av-gone', 'av-never', 'av-bobs', 'sound-av-pop', 'av-here'],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assets: [
      { id: 'av-here', status: 'present' },
      { id: 'av-gone', status: 'missing' },
      { id: 'av-never', status: 'missing' },
      { id: 'av-bobs', status: 'forbidden' },
      { id: 'sound-av-pop', status: 'present' },
    ] });
  });

  it("is scoped to the caller's project and validates the body", async () => {
    addAsset('av-scope', ALICE);
    const project = await newProject(ALICE);
    expect((await call(BOB, 'POST', `/projects/${project.id}/assets/availability`, { assetIds: ['av-scope'] })).statusCode).toBe(404);
    // Bob asking about Alice's asset from his own project learns only that it is not his.
    const bobs = await newProject(BOB);
    expect((await call(BOB, 'POST', `/projects/${bobs.id}/assets/availability`, { assetIds: ['av-scope'] })).json())
      .toEqual({ assets: [{ id: 'av-scope', status: 'forbidden' }] });
    expect((await call(ALICE, 'POST', `/projects/${project.id}/assets/availability`, { assetIds: [] })).statusCode).toBe(400);
    expect((await call(ALICE, 'POST', `/projects/${project.id}/assets/availability`, { ids: ['x'] })).statusCode).toBe(400);
  });
});

describe('PUT /assets/:id/original', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'editify-restore-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** 160 x 284 test pattern, no audio. */
  function clip(name: string, seconds: number, size = '160x284'): Buffer {
    const path = join(scratch, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path]);
    return readFileSync(path);
  }
  const gone = (id: string, owner: string, duration = 1): void => addAsset(id, owner, { file: false, duration, width: 160, height: 284, hasAudio: false });

  async function put(user: string, id: string, projectId: string, body: Buffer | object, name = 'clip.mp4') {
    return await app.inject({
      method: 'PUT',
      url: `/assets/${id}/original?projectId=${projectId}&name=${encodeURIComponent(name)}`,
      headers: { ...auth[user], ...(Buffer.isBuffer(body) ? { 'content-type': 'video/mp4' } : {}) },
      payload: body,
    });
  }

  it.skipIf(!hasFfmpeg)('puts a missing original back under its own id, then it is present', async () => {
    gone('restore-a', ALICE);
    const project = await newProject(ALICE);
    const response = await put(ALICE, 'restore-a', project.id, clip('one.mp4', 1));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'restore-a' });
    const stored = assets.get('restore-a')!;
    expect(stored.originalPath).toBe(join(assetsRoot, 'restore-a', 'original.mp4'));
    expect(existsSync(stored.originalPath)).toBe(true);
    expect(assets.linkedOrSound(project.id, 'restore-a')).toBe(true);
    expect((await call(ALICE, 'POST', `/projects/${project.id}/assets/availability`, { assetIds: ['restore-a'] })).json())
      .toEqual({ assets: [{ id: 'restore-a', status: 'present' }] });
    // Nothing but the original is left behind in its folder.
    expect(readdirSync(join(assetsRoot, 'restore-a'))).toEqual(['original.mp4']);
  });

  it.skipIf(!hasFfmpeg)('refuses another file (length, picture size, kind) and writes nothing', async () => {
    const project = await newProject(ALICE);
    gone('restore-b', ALICE);
    const longer = await put(ALICE, 'restore-b', project.id, clip('three.mp4', 3));
    expect(longer.statusCode).toBe(409);
    expect(longer.json()).toMatchObject({ code: 'mismatch' });
    expect((await put(ALICE, 'restore-b', project.id, clip('wide.mp4', 1, '320x180'))).statusCode).toBe(409);
    // The record has sound; a silent file of the same length and size is another clip.
    addAsset('restore-voice', ALICE, { file: false, duration: 1, width: 160, height: 284, hasAudio: true });
    expect((await put(ALICE, 'restore-voice', project.id, clip('silent.mp4', 1))).statusCode).toBe(409);
    expect((await put(ALICE, 'restore-b', project.id, Buffer.from('not media at all'))).statusCode).toBe(409);
    expect(existsSync(assets.get('restore-b')!.originalPath)).toBe(false);
    expect(readdirSync(join(assetsRoot, 'restore-b'))).toEqual([]);
  });

  it.skipIf(!hasFfmpeg)('lets two restores of the same clip race: each writes its own file, one whole file stays', async () => {
    gone('restore-race', ALICE);
    const project = await newProject(ALICE);
    const [first, second] = await Promise.all([
      put(ALICE, 'restore-race', project.id, clip('race-1.mp4', 1)),
      put(ALICE, 'restore-race', project.id, clip('race-2.mp4', 1)),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(readdirSync(join(assetsRoot, 'restore-race'))).toEqual(['original.mp4']);
  });

  it('answers a retry for an original already there without reading a body', async () => {
    addAsset('restore-here', ALICE);
    const project = await newProject(ALICE);
    const response = await put(ALICE, 'restore-here', project.id, {});
    expect(response.statusCode).toBe(200);
    expect(assets.get('restore-here')!.originalPath).toBe(join(media, 'restore-here.mp4'));
  });

  it('never creates an asset: an id with no row is 404, whatever its spelling', async () => {
    const project = await newProject(ALICE);
    const id = '0f8e1c0a-6b3d-4f7e-9a51-2c4d6e8f0a1b';
    expect((await put(ALICE, id, project.id, Buffer.from('x'))).statusCode).toBe(404);
    expect(assets.get(id)).toBeUndefined();
    expect(existsSync(join(assetsRoot, id))).toBe(false);
  });

  it("only takes canonical ids: another spelling of Alice's id can't reach her folder", async () => {
    const id = '1a2b3c4d-1111-4222-8333-444455556666';
    gone(id, ALICE);
    mkdirSync(join(assetsRoot, id), { recursive: true });
    writeFileSync(join(assetsRoot, id, 'proxy.mp4'), 'hers');
    const bobs = await newProject(BOB);
    for (const spelling of [id.toUpperCase(), '1A2b3c4d-1111-4222-8333-444455556666', 'Sound-x', 'a.b', 'x_y']) {
      expect((await put(BOB, spelling, bobs.id, Buffer.from('not media'))).statusCode).toBe(400);
    }
    // Bob with the exact id is told it doesn't exist.
    expect((await put(BOB, id, bobs.id, Buffer.from('not media'))).statusCode).toBe(404);
    expect(readFileSync(join(assetsRoot, id, 'proxy.mp4'), 'utf8')).toBe('hers');
  });

  it("refuses another account's asset and a missing project", async () => {
    addAsset('restore-bobs', BOB, { file: false });
    const project = await newProject(ALICE);
    expect((await put(ALICE, 'restore-bobs', project.id, Buffer.from('x'))).statusCode).toBe(404);
    const noProject = await app.inject({ method: 'PUT', url: '/assets/restore-bobs/original?name=a.mp4', headers: { ...auth[ALICE], 'content-type': 'video/mp4' }, payload: Buffer.from('x') });
    expect(noProject.statusCode).toBe(400);
  });
});
