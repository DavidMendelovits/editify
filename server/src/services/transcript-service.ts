import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredAsset } from '../db/asset-store.js';
import { analyzeEnergy } from '../media/audio-analysis.js';
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

export class TranscriptService {
  constructor(
    readonly store: TranscriptStore,
    private readonly runner: TranscriptionRunner = runWhisperTranscription,
    private readonly energyAnalyzer: EnergyAnalyzer = analyzeEnergy,
  ) {}

  get(assetId: string): StoredTranscript | undefined {
    return this.store.get(assetId);
  }

  async transcribe(asset: StoredAsset, force = false): Promise<StoredTranscript> {
    const existing = this.store.get(asset.id);
    if (existing && !force) {
      if (existing.energy) return existing;
      try { return this.store.putEnergy(asset.id, await this.energyAnalyzer(asset.originalPath)); } catch { return existing; }
    }
    const result = await this.runner(asset.originalPath);
    try {
      return this.store.put(asset.id, result, await this.energyAnalyzer(asset.originalPath));
    } catch {
      return this.store.put(asset.id, result);
    }
  }

  async ensureEnergy(asset: StoredAsset): Promise<EnergyAnalysis> {
    const existing = this.store.get(asset.id);
    if (!existing) throw new Error(`No transcript for asset ${asset.id}`);
    if (existing.energy) return existing.energy;
    return this.store.putEnergy(asset.id, await this.energyAnalyzer(asset.originalPath)).energy as EnergyAnalysis;
  }
}
