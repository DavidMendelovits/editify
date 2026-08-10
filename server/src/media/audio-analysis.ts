import { runProcess } from './process.js';
import { energyAnalysisSchema, type EnergyAnalysis } from '../db/transcript-store.js';

export async function analyzeEnergy(path: string): Promise<EnergyAnalysis> {
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-nostats', '-i', path,
    '-vn', '-af', 'aresample=48000,asetnsamples=n=2400:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ]);
  const rmsDb = [...stderr.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?(?:\d+(?:\.\d+)?|inf))/gi)]
    .map((match) => match[1]?.toLowerCase() === '-inf' ? -100 : Number(match[1]))
    .filter(Number.isFinite);
  if (rmsDb.length === 0) throw new Error('ffmpeg energy analysis returned no RMS cells');
  return energyAnalysisSchema.parse({ cellSeconds: 0.05, rmsDb });
}
