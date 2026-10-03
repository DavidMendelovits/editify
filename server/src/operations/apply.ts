// The edit rules live in @editify/shared so the phone runs the same ones (decision 5A).
export {
  OperationError,
  applyBatch,
  applyOperation,
  assertNoNewVideoOverlap,
  findVideoOverlaps,
  mergeTimeRanges,
  overlapKey,
  type ApplyOptions,
  type ClipOverlap,
  type TimeRange,
} from '@editify/shared';
