import { toCanvas } from 'html-to-image';
import type { HighlightRect, Screenshot } from './capture';

export type { HighlightRect, Screenshot } from './capture';

/** Long edge of what we send. Big enough to read the timeline, small enough to post. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.72;

/**
 * Paints each <video> onto a canvas pinned over it. The rasteriser walks the
 * DOM, and a <video> carries no frame in the DOM: without this pass the preview
 * comes out as an empty rectangle, which on a video editor is the middle of the
 * picture. Returns the undo, and never throws: a frame we cannot read (a
 * cross-origin source taints the canvas) just stays blank.
 */
function freezeVideos(): () => void {
  const covers: HTMLCanvasElement[] = [];
  for (const video of Array.from(document.querySelectorAll('video'))) {
    const box = video.getBoundingClientRect();
    if (!box.width || !box.height || !video.videoWidth) continue;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      // Round-trips the pixels to prove the canvas is readable before it goes
      // anywhere near the capture.
      canvas.toDataURL('image/jpeg', 0.1);
      Object.assign(canvas.style, {
        position: 'fixed',
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        objectFit: 'contain',
        zIndex: '2147483646',
      });
      document.body.appendChild(canvas);
      covers.push(canvas);
    } catch {
      // Tainted or not yet decoded. The rest of the screenshot is still worth having.
    }
  }
  return () => { for (const cover of covers) cover.remove(); };
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
 * The current screen as a JPEG. Called before the report sheet opens, so what
 * it captures is what the user was looking at when they decided to report.
 * Stays on the device unless the user attaches it.
 */
export async function captureScreen(): Promise<Screenshot | undefined> {
  const unfreeze = freezeVideos();
  try {
    const canvas = await toCanvas(document.body, {
      // A <video> node fails the rasteriser outright (it inlines the DOM into an
      // SVG image, and the browser refuses to load one containing a video), so
      // the elements are skipped and the frozen frames above stand in for them.
      filter: (node) => node.nodeName !== 'VIDEO',
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
    unfreeze();
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
