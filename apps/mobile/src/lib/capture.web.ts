import { toCanvas } from 'html-to-image';
import type { HighlightRect, Screenshot } from './capture';

export type { HighlightRect, Screenshot } from './capture';

/** Long edge of what we send. Big enough to read the timeline, small enough to post. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.72;

/**
 * Everything on screen that could be the user's footage: the preview video, the
 * filmstrips, the thumbnails and poster frames, any sticker they imported.
 *
 * A screenshot exists to show the interface, and none of that needs a single
 * frame of what someone filmed. The rule is deliberately blunt: every <img> and
 * <video>, and every background image that is not a data URI, is replaced with
 * a labelled placeholder of exactly the same size and position. Layout bugs
 * still read perfectly; the footage never leaves the device.
 */
const PLACEHOLDER_FILL = '#1E1E21';
const PLACEHOLDER_EDGE = '#3A3A42';
const PLACEHOLDER_TEXT = '#7A7A85';

function placeholder(box: DOMRect, label: string): HTMLElement {
  const cover = document.createElement('div');
  cover.dataset['editifyRedaction'] = 'true';
  cover.textContent = label;
  Object.assign(cover.style, {
    position: 'fixed',
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    // A diagonal hatch reads as "deliberately removed" rather than as a bug in
    // the app or in the capture.
    background: `repeating-linear-gradient(45deg, ${PLACEHOLDER_FILL}, ${PLACEHOLDER_FILL} 6px, #17171A 6px, #17171A 12px)`,
    border: `1px solid ${PLACEHOLDER_EDGE}`,
    boxSizing: 'border-box',
    color: PLACEHOLDER_TEXT,
    font: '500 11px system-ui, sans-serif',
    letterSpacing: '0.5px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    zIndex: '2147483646',
  });
  return cover;
}

/**
 * Covers every piece of media and suppresses CSS background images. Returns the
 * undo, which the caller runs in a `finally` so a failed capture cannot leave
 * the app looking redacted.
 */
function redactMedia(): () => void {
  const covers: HTMLElement[] = [];
  const restores: Array<() => void> = [];

  for (const element of Array.from(document.querySelectorAll('video, img'))) {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const isVideo = element.tagName === 'VIDEO';
    // The dimensions are the diagnostic part: a clip laid out at the wrong size
    // is visible here, the picture is not.
    const size = `${Math.round(box.width)}x${Math.round(box.height)}`;
    const cover = placeholder(box, box.width > 90 ? `${isVideo ? 'VIDEO' : 'MEDIA'} ${size}` : '');
    document.body.appendChild(cover);
    covers.push(cover);
  }

  for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    // Every url() background, whatever the scheme. A picked file renders as a
    // blob: or data: URI, so exempting those would be exempting exactly the
    // media that never came from our own server. CSS gradients carry no url()
    // and are left alone, which is all the app itself uses.
    const image = getComputedStyle(element).backgroundImage;
    if (image === 'none' || !image.includes('url(')) continue;
    const previous = element.style.backgroundImage;
    element.style.backgroundImage = 'none';
    restores.push(() => { element.style.backgroundImage = previous; });
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const cover = placeholder(box, box.width > 90 ? `MEDIA ${Math.round(box.width)}x${Math.round(box.height)}` : '');
    document.body.appendChild(cover);
    covers.push(cover);
  }

  return () => {
    for (const cover of covers) cover.remove();
    for (const restore of restores) restore();
  };
}

function toJpeg(canvas: HTMLCanvasElement): Screenshot {
  const scale = Math.min(1, MAX_EDGE / Math.max(canvas.width, canvas.height));
  if (scale === 1) {
    return { data: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: canvas.width, height: canvas.height };
  }
  const scaled = document.createElement('canvas');
  scaled.width = Math.round(canvas.width * scale);
  scaled.height = Math.round(canvas.height * scale);
  scaled.getContext('2d')?.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return { data: scaled.toDataURL('image/jpeg', JPEG_QUALITY), width: scaled.width, height: scaled.height };
}

/**
 * The current screen as a JPEG, with every frame of media replaced by a
 * placeholder. Called before the report sheet opens, so it shows the interface
 * the user was looking at when they decided to report, and it stays on the
 * device unless they attach it.
 */
export async function captureScreen(): Promise<Screenshot | undefined> {
  const restore = redactMedia();
  try {
    const canvas = await toCanvas(document.body, {
      // Belt and braces on top of the placeholders: media nodes never reach the
      // raster at all. It is also required for correctness, because a <video>
      // node fails the rasteriser outright (it inlines the DOM into an SVG
      // image, and the browser refuses to load one containing a video).
      filter: (node) => node.nodeName !== 'VIDEO' && node.nodeName !== 'IMG',
      backgroundColor: '#040408',
      // 1x: a retina capture of a 1512pt window is 3024px and several megabytes
      // before it is even scaled back down.
      pixelRatio: 1,
      cacheBust: false,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    return toJpeg(canvas);
  } catch {
    // A font or image the rasteriser could not read. A report without a picture
    // is still a report.
    return undefined;
  } finally {
    restore();
  }
}

/** Burns the highlight box into the image, so the issue shows it without a viewer. */
export async function annotate(shot: Screenshot, rect: HighlightRect): Promise<Screenshot> {
  try {
    const image = new Image();
    image.src = shot.data;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = shot.width;
    canvas.height = shot.height;
    const context = canvas.getContext('2d');
    if (!context) return shot;
    context.drawImage(image, 0, 0, shot.width, shot.height);
    const box = {
      x: rect.x * shot.width,
      y: rect.y * shot.height,
      width: rect.width * shot.width,
      height: rect.height * shot.height,
    };
    // Dim everything outside the box, then outline it: the eye goes to the one
    // part of the screen the reporter meant.
    context.fillStyle = 'rgba(4, 4, 8, 0.55)';
    context.fillRect(0, 0, shot.width, box.y);
    context.fillRect(0, box.y + box.height, shot.width, shot.height - box.y - box.height);
    context.fillRect(0, box.y, box.x, box.height);
    context.fillRect(box.x + box.width, box.y, shot.width - box.x - box.width, box.height);
    context.strokeStyle = '#F0656B';  // colors.danger
    context.lineWidth = Math.max(2, Math.round(shot.width / 400));
    context.strokeRect(box.x, box.y, box.width, box.height);
    return { data: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: shot.width, height: shot.height };
  } catch {
    return shot;
  }
}

/** The testID or label RN Web put on the element, whichever the component set. */
function nameOf(element: Element): string | undefined {
  const testId = element.getAttribute('data-testid');
  if (testId) return testId;
  const label = element.getAttribute('aria-label');
  if (label) return label;
  return undefined;
}

/**
 * What sits under the highlight, in the app's own vocabulary. A box on a picture
 * says where; this says what, so the fix can start from a component rather than
 * from a pixel coordinate.
 */
export function describeHighlight(rect: HighlightRect): string | undefined {
  try {
    const x = (rect.x + rect.width / 2) * window.innerWidth;
    const y = (rect.y + rect.height / 2) * window.innerHeight;
    const named = document.elementsFromPoint(x, y)
      .map((element) => nameOf(element))
      .filter((name): name is string => Boolean(name));
    if (!named.length) {
      // Nothing labelled: the text under the cursor is still a lead.
      const text = document.elementFromPoint(x, y)?.textContent?.trim().slice(0, 80);
      return text ? `text "${text}"` : undefined;
    }
    // Innermost first, and the two above it for context.
    return named.slice(0, 3).join(' in ');
  } catch {
    return undefined;
  }
}
