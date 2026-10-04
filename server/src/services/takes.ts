// Retake detection is pure edit logic and lives in @editify/shared (device-first plan, P1).
export {
  TAKE_LEAD_SEC,
  TAKE_TAIL_SEC,
  buildTakeMap,
  snapTakeToWords,
  splitSentences,
  type SuggestedTake,
  type TakeGroup,
  type TakeMap,
  type TakeSentence,
} from '@editify/shared';
