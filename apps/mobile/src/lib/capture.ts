/**
 * Screen capture for the report sheet. Native has no equivalent of the web
 * implementation in `capture.web.ts` (a DOM rasteriser), so it reports nothing
 * and the reporter simply offers no screenshot there.
 */

/** A captured frame, kept in memory until the user chooses to attach it. */
export interface Screenshot {
  /** A `data:image/jpeg;base64,...` URL, already downscaled. */
  data: string;
  width: number;
  height: number;
}

/** Normalized to the image, so it survives any later resizing. */
export interface HighlightRect { x: number; y: number; width: number; height: number }

export async function captureScreen(): Promise<Screenshot | undefined> {
  return undefined;
}

export function annotate(shot: Screenshot, _rect: HighlightRect): Promise<Screenshot> {
  return Promise.resolve(shot);
}

export function describeHighlight(_rect: HighlightRect): string | undefined {
  return undefined;
}
