// Types only: index.ts re-exports this module, so a value import would close a cycle.
import type { AssetInsights, Clip, Project } from './index.js';
import { PRESETS_BY_NAME, type PresetName } from './presets.js';

/** Mirrors `clipTimelineDuration` in index.ts, which cannot be imported here without a cycle. */
function timelineDuration(clip: Clip): number {
  return (clip.out - clip.in) / (clip.speed ?? 1);
}

/** One line of a preset checklist. `suggestion` is what to do about it, shown when `met` is false. */
export interface ChecklistCriterion {
  id: string;
  label: string;
  met: boolean;
  suggestion: string;
}

export interface ChecklistResult {
  presetName: PresetName;
  title: string;
  items: ChecklistCriterion[];
  score: number;
  total: number;
}

/** Everything a criterion is allowed to look at — derived once per evaluation. */
interface Scope {
  project: Project;
  insights: AssetInsights[];
  videoClips: Clip[];
  captionClips: Clip[];
  audioClips: Clip[];
  maxShotSeconds: number;
  targetDurationSec: readonly [number, number];
}

interface CriterionDef {
  id: string;
  label: string;
  suggestion: string;
  test: (scope: Scope) => boolean;
}

function clipsOfKind(project: Project, kind: 'video' | 'audio' | 'caption' | 'overlay'): Clip[] {
  return project.tracks.filter((track) => track.kind === kind).flatMap((track) => track.clips);
}

/** A source span made the cut when some clip of that asset keeps part of it. */
function spanSurvives(videoClips: Clip[], assetId: string, start: number, end: number): boolean {
  return videoClips.some((clip) => clip.assetId === assetId && clip.in < end && clip.out > start);
}

/** Stricter than `spanSurvives`: the whole span has to sit inside one clip. */
function spanFullyKept(videoClips: Clip[], assetId: string, start: number, end: number): boolean {
  return videoClips.some((clip) => clip.assetId === assetId && clip.in <= start && clip.out >= end);
}

function hasHookInCut(scope: Scope): boolean {
  return scope.insights.some((insight) =>
    insight.hook !== null && spanSurvives(scope.videoClips, insight.assetId, insight.hook.start, insight.hook.end));
}

function carriesPunchIn(clip: Clip): boolean {
  if (!clip.transform && !clip.transformEnd) return false;
  const from = clip.transform?.scale ?? 1;
  const to = clip.transformEnd?.scale ?? from;
  return to !== from || from > 1;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const HOOK: CriterionDef = {
  id: 'hook',
  label: 'Opens on a hook',
  suggestion: "We couldn't find a hook in the cut. Film a punchy opening line and put it first.",
  test: hasHookInCut,
};

const CAPTIONS: CriterionDef = {
  id: 'captions',
  label: 'Captions on screen',
  suggestion: 'No captions yet. Ask for burned-in captions so the edit reads with the sound off.',
  test: (scope) => scope.captionClips.length > 0,
};

const CHECKLIST_DEFS: Record<string, { title: string; criteria: CriterionDef[] }> = {
  talking_head_punchy: {
    title: 'Punchy talking head',
    criteria: [
      HOOK,
      CAPTIONS,
      {
        id: 'action_words',
        label: 'Key words emphasised',
        suggestion: 'Captions are flat. Turn on keyword highlighting so the punch words pop.',
        test: (scope) => scope.captionClips.some((clip) => clip.style?.emphasis === 'highlight' || Boolean(clip.style?.emphasisColor)),
      },
      {
        id: 'zoom_ins',
        label: 'Consistent punch-ins',
        suggestion: 'Add alternating punch-ins so a single angle reads as multi-cam.',
        test: (scope) => scope.videoClips.filter(carriesPunchIn).length >= 2,
      },
      {
        id: 'pacing',
        label: 'Punchy pacing',
        suggestion: 'A shot runs long. Cut the dead air or split it so nothing holds past the preset ceiling.',
        test: (scope) => scope.videoClips.length > 0
          && scope.videoClips.every((clip) => timelineDuration(clip) <= scope.maxShotSeconds),
      },
    ],
  },
  standup_clip: {
    title: 'Stand-up clip',
    criteria: [
      HOOK,
      CAPTIONS,
      {
        id: 'punchline',
        label: 'Punchline protected',
        suggestion: "The punchline didn't make the cut. Extend the clip to include it or re-record the ending.",
        test: (scope) => scope.insights.some((insight) => insight.highlights.some((highlight) =>
          highlight.label.toLowerCase() === 'punchline'
          && spanFullyKept(scope.videoClips, insight.assetId, highlight.start, highlight.end))),
      },
      {
        id: 'tight_duration',
        label: 'Tight duration',
        suggestion: 'The cut sits outside the sweet spot for this format. Trim the setup or add another beat.',
        test: (scope) => scope.project.duration >= scope.targetDurationSec[0]
          && scope.project.duration <= scope.targetDurationSec[1],
      },
    ],
  },
  vlog_montage: {
    title: 'Day in the life',
    criteria: [
      {
        id: 'music',
        label: 'Music bed',
        suggestion: 'A montage needs music. Drop a track underneath and let it set the pace.',
        test: (scope) => scope.audioClips.length > 0,
      },
      {
        id: 'quick_cuts',
        label: 'Quick cuts',
        suggestion: 'Shots are lingering. Tighten them so the montage keeps moving, or shoot more coverage to cut to.',
        test: (scope) => scope.videoClips.length > 0
          && median(scope.videoClips.map(timelineDuration)) <= scope.maxShotSeconds,
      },
      CAPTIONS,
      HOOK,
    ],
  },
};

export const CHECKLIST_PRESETS: Readonly<Record<string, { title: string; criteria: readonly CriterionDef[] }>> = CHECKLIST_DEFS;

/** Preset names that carry a checklist — a subset of the editing presets. */
export const CHECKLIST_PRESET_NAMES = Object.keys(CHECKLIST_DEFS) as PresetName[];

/** Throws on a preset with no checklist definition. */
export function evaluateChecklist(presetName: string, project: Project, insights: AssetInsights[]): ChecklistResult {
  const definition = CHECKLIST_DEFS[presetName];
  const preset = PRESETS_BY_NAME[presetName as PresetName];
  if (!definition || !preset) throw new Error(`No checklist for preset "${presetName}"`);

  const scope: Scope = {
    project,
    insights,
    videoClips: clipsOfKind(project, 'video'),
    captionClips: clipsOfKind(project, 'caption'),
    audioClips: clipsOfKind(project, 'audio'),
    maxShotSeconds: preset.maxShotSeconds,
    targetDurationSec: preset.targetDurationSec as readonly [number, number],
  };

  const items = definition.criteria.map(({ id, label, suggestion, test }) => ({
    id, label, suggestion, met: test(scope),
  }));
  return {
    presetName: presetName as PresetName,
    title: definition.title,
    items,
    score: items.filter((item) => item.met).length,
    total: items.length,
  };
}
