/**
 * Transcriber score (release 1.1, T10; the 2A ground-truth harness): the device Transcriber
 * adapters, run for real on this Mac, scored against a reference transcript.
 *
 *   npx tsx scripts/score-transcribers.ts [--media <audio or video>] [--reference <words.json>]
 *       [--reference-model medium] [--engines speech-analyzer,sfspeech,sfspeech-single]
 *       [--hypothesis name=<transcript.json>]... [--fresh] [--no-ask]
 *
 *   media ──▶ reference: --reference (hand-corrected, or any {words:[{w,s,e}]}), else
 *   │         scripts/transcribe.py (server faster-whisper) with --reference-model, cached
 *   ├───────▶ parity/transcriber-score (swiftc: Core + the real SpeechAnalyzer and SFSpeech
 *   │         adapters, macOS 26+) ─▶ each engine's transcript, cached
 *   ▼
 *   normalize (lowercase, punctuation and fillers stripped, numbers as words) ─▶ align to the
 *   reference by edit distance ─▶ WER, word start error p50/p95 on matched words, errors around
 *   each SFSpeech chunk seam, caption segments, runtime ─▶ a markdown table + score.json
 *
 * Everything lands in server/data/transcriber-score (gitignored). Media and transcripts are
 * never committed: the stand-up set is the founder's own material.
 *
 * SFSpeech asks for speech-recognition permission on first run. With nobody at the Mac the
 * prompt hangs; --no-ask skips it (on macOS on-device recognition runs without it).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const engineRoot = resolve(serverRoot, '..', 'apps/mobile/modules/editify-engine');
const outDir = join(serverRoot, 'data', 'transcriber-score');

interface Word { w: string; s: number; e: number }
interface Segment { text: string; s: number; e: number }
interface Transcript { words: Word[]; segments?: Segment[] }
interface Chunk { index: number; start: number; end: number }
interface EngineRun { engine: string; ok: boolean; seconds: number; error?: string; transcript?: Transcript; chunks?: Chunk[] }

// ── arguments ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function option(name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}
const flag = (name: string): boolean => argv.includes(`--${name}`);
const hypotheses = argv.flatMap((arg, i) => (arg === '--hypothesis' && argv[i + 1] ? [argv[i + 1]!] : []));

function findUp(name: string, from: string): string | undefined {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, name))) return join(dir, name);
  return undefined;
}

/** Default media: the voice memo in "stand-up audio sync test" next to the main checkout's .env.local. */
function defaultMedia(): string {
  const folder = join(dirname(findUp('.env.local', serverRoot) ?? serverRoot), 'stand-up audio sync test');
  const memo = existsSync(folder) ? readdirSync(folder).find((name) => ['.m4a', '.wav', '.mp3', '.aac'].includes(extname(name).toLowerCase())) : undefined;
  if (!memo) throw new Error(`no --media given and no audio file in ${folder}`);
  return join(folder, memo);
}

const media = resolve(option('media') ?? defaultMedia());
const engines = option('engines') ?? 'speech-analyzer,sfspeech,sfspeech-single';
const referenceModel = option('reference-model') ?? 'medium';
const fresh = flag('fresh');
mkdirSync(outDir, { recursive: true });
const tag = basename(media, extname(media)).replace(/[^\w-]+/g, '_');

// ── reference ─────────────────────────────────────────────────────────────
function loadReference(): { transcript: Transcript; kind: string; seconds?: number } {
  const given = option('reference');
  if (given) return { transcript: JSON.parse(readFileSync(given, 'utf8')) as Transcript, kind: `file ${basename(given)}` };
  const cached = join(outDir, `${tag}.reference-${referenceModel}.json`);
  if (!existsSync(cached) || fresh) {
    process.stderr.write(`reference: faster-whisper ${referenceModel} on ${basename(media)} (set HF_HOME to keep the model out of your cache)\n`);
    const started = Date.now();
    const out = execFileSync('python3', [join(serverRoot, 'scripts', 'transcribe.py'), media, referenceModel], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
    writeFileSync(cached, JSON.stringify({ ...JSON.parse(out.toString()), seconds: (Date.now() - started) / 1000 }));
  }
  const data = JSON.parse(readFileSync(cached, 'utf8')) as Transcript & { seconds?: number };
  return { transcript: data, kind: `faster-whisper ${referenceModel} (model reference, not hand-corrected)`, seconds: data.seconds };
}

// ── device engines ────────────────────────────────────────────────────────
const HARNESS_SOURCES = [
  'Core/EditifyCore', 'Core/Ports/DevicePorts', 'Core/Ports/SpeechPorts', 'Core/Analysis', 'Core/AnalysisSupport', 'Core/AnalysisMath',
  'Core/AudioSync', 'Core/TranscriptAssembler', 'Core/SpeechChunks', 'Core/TranscriberChain', 'Core/TierPolicy', 'Engine/AudioDecode',
  'Engine/Adapters/SFSpeechTranscriber', 'Engine/Adapters/SpeechAnalyzerTranscriber',
].map((name) => join(engineRoot, 'ios', `${name}.swift`));

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.editify.transcriber-score</string>
<key>CFBundleName</key><string>transcriber-score</string>
<key>NSSpeechRecognitionUsageDescription</key><string>Scores the on-device speech transcribers.</string>
</dict></plist>
`;

function runEngines(): { runs: EngineRun[]; authorization: string } {
  const cached = join(outDir, `${tag}.engines.json`);
  if (existsSync(cached) && !fresh) return JSON.parse(readFileSync(cached, 'utf8')) as { runs: EngineRun[]; authorization: string };
  if (process.platform !== 'darwin') throw new Error('the device engines need macOS 26+');
  const plist = join(outDir, 'Info.plist');
  const binary = join(outDir, 'transcriber-score');
  writeFileSync(plist, INFO_PLIST);
  process.stderr.write('building parity/transcriber-score\n');
  execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', 'arm64-apple-macos26.0', ...HARNESS_SOURCES,
    join(engineRoot, 'parity/transcriber-score/main.swift'), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
    '-Xlinker', plist, '-o', binary], { stdio: 'inherit' });
  const env = flag('no-ask') ? { ...process.env, TRANSCRIBER_SCORE_NO_ASK: '1' } : process.env;
  const result = spawnSync(binary, [media, engines], { encoding: 'utf8', env, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error(`transcriber-score exited ${result.status}`);
  const parsed = JSON.parse(result.stdout) as { engines: EngineRun[]; authorization: string };
  const out = { runs: parsed.engines, authorization: parsed.authorization };
  writeFileSync(cached, JSON.stringify(out));
  return out;
}

// ── normalization ─────────────────────────────────────────────────────────
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** Fillers the reference model drops and SpeechAnalyzer writes ("Um...", "uh"): not scored. */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'hmm', 'mm', 'mhm', 'er', 'erm']);

function numberWords(n: number): string[] {
  if (n < 20) return [ONES[n]!];
  if (n < 100) return [TENS[Math.floor(n / 10)]!, ...(n % 10 ? [ONES[n % 10]!] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)]!, 'hundred', ...(n % 100 ? numberWords(n % 100) : [])];
  if (n < 10000 && n >= 1100 && n < 2100 && n % 100 !== 0) return [...numberWords(Math.floor(n / 100)), ...numberWords(n % 100)]; // years: 1999, 2025
  if (n < 1_000_000) return [...numberWords(Math.floor(n / 1000)), 'thousand', ...(n % 1000 ? numberWords(n % 1000) : [])];
  return String(n).split('').map((digit) => ONES[Number(digit)]!);
}

/** One spoken token's normalized words: lowercase, digits spelled out, punctuation gone. */
export function normalizeToken(raw: string): string[] {
  const text = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/%/g, ' percent ').replace(/&/g, ' and ').replace(/[-/]/g, ' ');
  return text.split(/\s+/).flatMap((piece) => {
    const digits = piece.replace(/[,.](?=\d)/g, '').match(/^\$?(\d+)(st|nd|rd|th|s)?\W*$/);
    if (digits) return numberWords(Number(digits[1]));
    const word = piece.replace(/[^a-z0-9']/g, '').replace(/'/g, '');
    return word && !FILLERS.has(word) ? [word] : [];
  });
}

interface Token { t: string; s: number; e: number }

/** Normalized tokens with times; a multi-word item (SFSpeech's "get out") shares its span evenly. */
export function tokens(words: Word[]): Token[] {
  return words.flatMap((word) => {
    const parts = normalizeToken(word.w);
    const step = parts.length ? (word.e - word.s) / parts.length : 0;
    return parts.map((t, i) => ({ t, s: word.s + i * step, e: word.s + (i + 1) * step }));
  });
}

// ── alignment ─────────────────────────────────────────────────────────────
type Op = { kind: 'ok' | 'sub'; r: number; h: number } | { kind: 'del'; r: number } | { kind: 'ins'; h: number };

/** Levenshtein alignment of hypothesis to reference tokens (unit costs), with the edit path. */
export function align(ref: Token[], hyp: Token[]): Op[] {
  const n = ref.length, m = hyp.length;
  const cost = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => i * (m + 1) + j;
  for (let i = 0; i <= n; i++) cost[at(i, 0)] = i;
  for (let j = 0; j <= m; j++) cost[at(0, j)] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = cost[at(i - 1, j - 1)]! + (ref[i - 1]!.t === hyp[j - 1]!.t ? 0 : 1);
      cost[at(i, j)] = Math.min(diag, cost[at(i - 1, j)]! + 1, cost[at(i, j - 1)]! + 1);
    }
  }
  const ops: Op[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[at(i, j)] === cost[at(i - 1, j - 1)]! + (ref[i - 1]!.t === hyp[j - 1]!.t ? 0 : 1)) {
      ops.push({ kind: ref[i - 1]!.t === hyp[j - 1]!.t ? 'ok' : 'sub', r: i - 1, h: j - 1 });
      i--; j--;
    } else if (i > 0 && cost[at(i, j)] === cost[at(i - 1, j)]! + 1) {
      ops.push({ kind: 'del', r: i - 1 });
      i--;
    } else {
      ops.push({ kind: 'ins', h: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

interface SeamScore { at: number; refWords: number; del: number; ins: number; sub: number; doubles: number }
interface Score {
  engine: string; seconds: number; refWords: number; hypWords: number; sub: number; del: number; ins: number; wer: number;
  matched: number; startErrorP50Ms: number; startErrorP95Ms: number; startErrorMeanMs: number;
  segments: number; meanSegmentSeconds: number; meanSegmentWords: number; seams: SeamScore[];
}

/** Errors whose reference time (or neighbouring reference time, for insertions) falls in [lo, hi). */
function windowErrors(ops: Op[], ref: Token[], hyp: Token[], lo: number, hi: number): Omit<SeamScore, 'at'> {
  const out = { refWords: 0, del: 0, ins: 0, sub: 0, doubles: 0 };
  let lastRefTime = 0;
  for (const op of ops) {
    const time = op.kind === 'ins' ? hyp[op.h]!.s : ref[op.r]!.s;
    if (op.kind !== 'ins') lastRefTime = ref[op.r]!.s;
    const inWindow = time >= lo && time < hi && (op.kind !== 'ins' || (lastRefTime >= lo - 2 && lastRefTime < hi + 2));
    if (!inWindow) continue;
    if (op.kind !== 'ins') out.refWords++;
    if (op.kind === 'del') out.del++;
    if (op.kind === 'sub') out.sub++;
    if (op.kind === 'ins') {
      out.ins++;
      const previous = hyp[op.h - 1], next = hyp[op.h + 1];
      if ((previous && previous.t === hyp[op.h]!.t) || (next && next.t === hyp[op.h]!.t)) out.doubles++;
    }
  }
  return out;
}

function score(engine: string, seconds: number, refTokens: Token[], transcript: Transcript, seamTimes: number[]): Score & { ops: Op[]; hyp: Token[] } {
  const hyp = tokens(transcript.words);
  const ops = align(refTokens, hyp);
  const count = (kind: Op['kind']): number => ops.filter((op) => op.kind === kind).length;
  const errors = ops.flatMap((op) => (op.kind === 'ok' ? [Math.abs(hyp[op.h]!.s - refTokens[op.r]!.s) * 1000] : []));
  const segments = transcript.segments ?? [];
  const sub = count('sub'), del = count('del'), ins = count('ins');
  return {
    engine, seconds, refWords: refTokens.length, hypWords: hyp.length, sub, del, ins, wer: (sub + del + ins) / Math.max(1, refTokens.length),
    matched: errors.length, startErrorP50Ms: percentile(errors, 50), startErrorP95Ms: percentile(errors, 95),
    startErrorMeanMs: errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length),
    segments: segments.length,
    meanSegmentSeconds: segments.reduce((sum, seg) => sum + (seg.e - seg.s), 0) / Math.max(1, segments.length),
    meanSegmentWords: hyp.length / Math.max(1, segments.length),
    seams: seamTimes.map((at) => ({ at, ...windowErrors(ops, refTokens, hyp, at - 2, at + 2) })),
    ops, hyp,
  };
}

// ── report ────────────────────────────────────────────────────────────────
const reference = loadReference();
const refTokens = tokens(reference.transcript.words);
const device = runEngines();
const extra: EngineRun[] = hypotheses.map((spec) => {
  const [name, path] = spec.split('=') as [string, string];
  return { engine: name, ok: true, seconds: NaN, transcript: JSON.parse(readFileSync(path, 'utf8')) as Transcript };
});
const runs = [...device.runs, ...extra];
const chunks = device.runs.find((run) => run.chunks)?.chunks ?? [];
// The cut between chunk i and i + 1 is the middle of their overlap (SpeechChunks.merge).
const seamTimes = chunks.slice(1).map((chunk, i) => (chunk.start + chunks[i]!.end) / 2);

const scores = runs.filter((run) => run.ok && run.transcript).map((run) => score(run.engine, run.seconds, refTokens, run.transcript!, seamTimes));
const failed = runs.filter((run) => !run.ok);
const fmt = (value: number, digits = 0): string => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const lines: string[] = [];
lines.push(`Media: ${basename(media)}  Reference: ${reference.kind}, ${refTokens.length} words${reference.seconds ? `, ${fmt(reference.seconds)} s` : ''}`);
lines.push(`Speech permission at run: ${device.authorization}`);
lines.push('');
lines.push('| Engine | WER | Sub | Del | Ins | Words | Start err p50 | p95 | Segments | Mean seg | Words/seg | Runtime |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of scores) {
  lines.push(`| ${s.engine} | ${pct(s.wer)} | ${s.sub} | ${s.del} | ${s.ins} | ${s.hypWords} | ${fmt(s.startErrorP50Ms)} ms | ${fmt(s.startErrorP95Ms)} ms | ${s.segments} | ${fmt(s.meanSegmentSeconds, 1)} s | ${fmt(s.meanSegmentWords, 1)} | ${fmt(s.seconds, 1)} s |`);
}
for (const run of failed) lines.push(`| ${run.engine} | failed: ${run.error} |`);
if (seamTimes.length) {
  lines.push('');
  lines.push(`Errors within 2 s of each SFSpeech chunk cut (${seamTimes.map((t) => `${t} s`).join(', ')}), del/ins/sub (doubles):`);
  lines.push('');
  lines.push(`| Engine | ${seamTimes.map((t) => `${t} s`).join(' | ')} | Total |`);
  lines.push(`|---|${seamTimes.map(() => '---').join('|')}|---|`);
  for (const s of scores) {
    const total = s.seams.reduce((acc, seam) => ({ del: acc.del + seam.del, ins: acc.ins + seam.ins, sub: acc.sub + seam.sub, doubles: acc.doubles + seam.doubles }), { del: 0, ins: 0, sub: 0, doubles: 0 });
    const cell = (x: { del: number; ins: number; sub: number; doubles: number }): string => `${x.del}/${x.ins}/${x.sub} (${x.doubles})`;
    lines.push(`| ${s.engine} | ${s.seams.map(cell).join(' | ')} | ${cell(total)} |`);
  }
}

// Spot checks: where the reference and SpeechAnalyzer disagree the most, a human listens.
const anchor = scores.find((s) => s.engine === 'speech-analyzer') ?? scores[0];
const spots: Array<{ at: number; reference: string; heard: string; errors: number }> = [];
if (anchor) {
  let run: Op[] = [];
  const flush = (): void => {
    const errs = run.filter((op) => op.kind !== 'ok').length;
    if (errs >= 2) {
      const refs = run.flatMap((op) => (op.kind === 'ins' ? [] : [refTokens[op.r]!]));
      const hyps = run.flatMap((op) => (op.kind === 'del' ? [] : [anchor.hyp[op.h]!]));
      spots.push({ at: (refs[0] ?? hyps[0])!.s, reference: refs.map((t) => t.t).join(' '), heard: hyps.map((t) => t.t).join(' '), errors: errs });
    }
    run = [];
  };
  let clean = 0;
  for (const op of anchor.ops) {
    if (op.kind === 'ok') { clean++; if (run.length) run.push(op); if (clean >= 2) flush(); continue; }
    clean = 0;
    run.push(op);
  }
  flush();
  spots.sort((a, b) => b.errors - a.errors);
}
const topSpots = spots.slice(0, 10).sort((a, b) => a.at - b.at);

writeFileSync(join(outDir, `${tag}.score.json`), JSON.stringify({
  media: basename(media), reference: reference.kind, authorization: device.authorization, seamTimes,
  scores: scores.map(({ ops: _ops, hyp: _hyp, ...rest }) => rest), failed, spotChecks: topSpots,
}, null, 2));
process.stdout.write(`${lines.join('\n')}\n`);
process.stdout.write(`\nSpot checks (reference vs ${anchor?.engine}; in ${join(outDir, `${tag}.score.json`)}): ${topSpots.map((spot) => `${fmt(spot.at, 1)} s`).join(', ')}\n`);
