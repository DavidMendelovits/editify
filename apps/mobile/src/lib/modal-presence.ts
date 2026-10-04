/**
 * Which app sheets are up as a React Native <Modal>, so a root-level sheet waits its turn.
 * On RN 0.81 iOS presents a Modal from the root view controller, and a second one can't come
 * up while another is presented (or still animating away). Imports finish inside ImportSheet
 * and SoundSheet, both Modals that stay open during the upload, so the speech pre-prompt
 * (SpeechPrompt) would be asked to show under them and never appear.
 *
 *   ImportSheet / SoundSheet visible ─▶ usePresentedModal(true) ─▶ open() ─▶ busy
 *   last one hides ─▶ release() ─▶ busy for `settleMs` more (the dismiss animation) ─▶ idle
 *   SpeechPrompt: visible = the flow wants the sheet && !busy   (deferredVisible)
 *
 * Free of React Native; the store runs under vitest with fake timers.
 */
import { useEffect, useSyncExternalStore } from 'react';

/** Long enough for a slide or fade dismissal to finish before another Modal presents. */
export const MODAL_SETTLE_MS = 450;

export interface ModalPresence {
  /** A sheet came up; call the returned release once it hides (twice is harmless). */
  open(): () => void;
  /** True while a sheet is up, or one hid less than `settleMs` ago. */
  busy(): boolean;
  subscribe(listener: () => void): () => void;
}

export function createModalPresence(options: { settleMs?: number } = {}): ModalPresence {
  const settleMs = options.settleMs ?? MODAL_SETTLE_MS;
  let open = 0;
  let settling: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  const listeners = new Set<() => void>();

  const update = (): void => {
    const next = open > 0 || settling !== null;
    if (next === busy) return;
    busy = next;
    for (const listener of listeners) listener();
  };

  return {
    open() {
      open += 1;
      if (settling) { clearTimeout(settling); settling = null; }
      update();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        open -= 1;
        if (open === 0) {
          settling = setTimeout(() => { settling = null; update(); }, settleMs);
        }
        update();
      };
    },
    busy: () => busy,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** The app's one store. */
export const modalPresence = createModalPresence();

/** A root-level sheet the flow asks for shows only once no other sheet is up. */
export function deferredVisible(wanted: boolean, otherModalBusy: boolean): boolean {
  return wanted && !otherModalBusy;
}

/** Marks a Modal-backed sheet as presented while `visible`. */
export function usePresentedModal(visible: boolean, presence: ModalPresence = modalPresence): void {
  useEffect(() => (visible ? presence.open() : undefined), [visible, presence]);
}

/** True while another sheet is up (or just went away). */
export function useOtherModalBusy(presence: ModalPresence = modalPresence): boolean {
  return useSyncExternalStore(presence.subscribe, presence.busy, presence.busy);
}
