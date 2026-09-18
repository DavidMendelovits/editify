/**
 * Screen capture for the report sheet. Native has no equivalent of the web
 * implementation in `capture.web.ts` (a DOM rasteriser), so it reports nothing
 * and the reporter simply offers no screenshot there.
 */

/** One labelled element as it sat on screen when the shot was taken, normalized. */
export interface CapturedElement { name: string; x: number; y: number; width: number; height: number }

/** A captured frame, kept in memory until the user chooses to attach it. */
export interface Screenshot {
  /** A `data:image/jpeg;base64,...` URL, already downscaled. */
  data: string;
  width: number;
  height: number;
  /**
   * What was where. Recorded with the shot because by the time the user drags
   * a highlight, the report sheet is over the app and the live DOM under those
   * coordinates is the sheet itself.
   */
  elements: CapturedElement[];
}

/** Normalized to the image, so it survives any later resizing. */
export interface HighlightRect { x: number; y: number; width: number; height: number }

export async function captureScreen(): Promise<Screenshot | undefined> {
  return undefined;
}

export function annotate(shot: Screenshot, _rect: HighlightRect): Promise<Screenshot> {
  return Promise.resolve(shot);
}

export function describeHighlight(_rect: HighlightRect, _elements: CapturedElement[]): string | undefined {
  return undefined;
}
