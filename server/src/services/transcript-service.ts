import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredAsset } from '../db/asset-store.js';
import { analyzeEnergy } from '../media/audio-analysis.js';
import { timeMediaJob } from './media-jobs.js';
import { mediaSlots, type MediaSlots, type SlotLane } from './media-slots.js';
import {
  transcriptResultSchema,
  type StoredTranscript,
  type TranscriptResult,
  type TranscriptStore,
  type EnergyAnalysis,
} from '../db/transcript-store.js';

const TRANSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/transcribe.py');

export type TranscriptionRunner = (mediaPath: string) => Promise<TranscriptResult>;
export type EnergyAnalyzer = (mediaPath: string) => Promise<EnergyAnalysis>;

export function runWhisperTranscription(mediaPath: string): Promise<TranscriptResult> {
  const python = process.env.PYTHON_BIN ?? 'python3';
  const model = process.env.WHISPER_MODEL ?? 'base';
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [scriptPath, mediaPath, model], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      reject(new Error(`Transcription timed out after ${TRANSCRIPTION_TIMEOUT_MS / 1000} seconds`));
    }, TRANSCRIPTION_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Transcription process exited with ${code}: ${stderr.trim().slice(-3000)}`));
        return;
      }
      try {
        resolvePromise(transcriptResultSchema.parse(JSON.parse(stdout)));
      } catch (error) {
        reject(new Error(`Invalid transcription output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

/**
 * A run in progress or waiting for a media slot. `started` flips once it holds
 * a slot; `replacedBy` is set when a slot-holding caller took over the run
 * before this one got a slot (see `transcribe`).
 */
interface InFlightRun {
  promise: Promise<StoredTranscript>;
  label: string;
  started: boolean;
  replacedBy?: InFlightRun;
}

export class TranscriptService {
  private readonly inFlight = new Map<string, InFlightRun>();

  constructor(
    readonly store: TranscriptStore,
    private readonly runner: TranscriptionRunner = runWhisperTranscription,
    private readonly energyAnalyzer: EnergyAnalyzer = analyzeEnergy,
    private readonly slots: MediaSlots = mediaSlots,
  ) {}

  get(assetId: string): StoredTranscript | undefined {
    return this.store.get(assetId);
  }

  /**
   * `lane: 'background'` is for work nobody is waiting on yet (an import
   * transcribing its own clip): it yields the slot queue to previews and
   * renders. A foreground caller that joins such a run while it still waits
   * for a slot promotes it, so the agent never waits behind a batch of encodes.
   */
  async transcribe(asset: StoredAsset, force = false, options: { lane?: SlotLane } = {}): Promise<StoredTranscript> {
    const lane = options.lane ?? 'foreground';
    const existing = this.store.get(asset.id);
    if (existing && !force) {
      if (existing.energy) return existing;
      try { return this.store.putEnergy(asset.id, await this.measureEnergy(asset)); } catch { return existing; }
    }
    // ponytail: a force=true call that lands mid-run joins the in-flight run
    // instead of starting a second Whisper pass — it gets a transcript that is
    // at most one run stale, which beats paying for minutes of duplicate GPU.
    const current = this.inFlight.get(asset.id);
    // Except when that run is still queued for a slot and this caller already
    // holds one (an import transcribing its own clip): joining would park a
    // slot on a job that may be waiting for that very slot. Run it here instead,
    // and let the queued run hand its callers over when its turn comes.
    if (current && (current.started || !this.slots.held())) {
      if (!current.started && lane === 'foreground') this.slots.promote(current.label);
      return await current.promise;
    }
    const run = this.start(asset, lane);
    if (current) current.replacedBy = run;
    return await run.promise;
  }

  private start(asset: StoredAsset, lane: SlotLane): InFlightRun {
    const run = { label: `transcribe ${asset.id}`, started: false } as InFlightRun;
    this.inFlight.set(asset.id, run);
    const queuedAt = performance.now();
    run.promise = this.slots.run(run.label, async () => {
      if (run.replacedBy) return undefined;
      run.started = true;
      return await this.run(asset, performance.now() - queuedAt);
    }, { lane })
      .then((result) => result ?? (run.replacedBy as InFlightRun).promise)
      .finally(() => {
        if (this.inFlight.get(asset.id) === run) this.inFlight.delete(asset.id);
      });
    return run;
  }

  private async run(asset: StoredAsset, waitMs: number): Promise<StoredTranscript> {
    const result = await timeMediaJob('transcribe', { assetId: asset.id }, () => this.runner(asset.originalPath), waitMs);
    try {
      return this.store.put(asset.id, result, await this.measureEnergy(asset));
    } catch {
      return this.store.put(asset.id, result);
    }
  }

  private measureEnergy(asset: StoredAsset): Promise<EnergyAnalysis> {
    return timeMediaJob('energy', { assetId: asset.id }, () => this.energyAnalyzer(asset.originalPath));
  }

  async ensureEnergy(asset: StoredAsset): Promise<EnergyAnalysis> {
    const existing = this.store.get(asset.id);
    if (!existing) throw new Error(`No transcript for asset ${asset.id}`);
    if (existing.energy) return existing.energy;
    return this.store.putEnergy(asset.id, await this.measureEnergy(asset)).energy as EnergyAnalysis;
  }
}
