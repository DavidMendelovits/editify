/**
 * What the sunset screen saves to Photos: the newest finished master of each
 * project, then every original the user uploaded. Pure, so it is tested
 * without a device; `photo-export.ts` does the downloading and saving.
 */

export interface ExportItem {
  kind: 'video' | 'original';
  /** The render or asset id: with `kind`, what `exportKey` remembers as saved. */
  id: string;
  /** A server path or absolute URL, rebased onto the API with credentials by the caller. */
  url: string;
  /** Local file name. Photos decides what a file is by its extension. */
  fileName: string;
}

interface RenderLike { id: string; status: string; outputUrl?: string | undefined }
interface AssetLike { id: string; originalName: string; mimeType: string; status?: string | undefined; originalUrl: string }

const EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-m4v': '.m4v',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/webp': '.webp',
};

/** Photos takes pictures and movies; audio, documents and the built-in sound library stay behind. */
function savable(asset: AssetLike): boolean {
  if (asset.id.startsWith('sound-')) return false;
  if (asset.status && asset.status !== 'ready') return false;
  return asset.mimeType.startsWith('video/') || asset.mimeType.startsWith('image/');
}

function fileNameFor(asset: AssetLike): string {
  const base = asset.originalName.split(/[\\/]/).pop()?.replace(/[^\w.\- ]+/g, '_').trim() || asset.id;
  if (/\.[A-Za-z0-9]{2,5}$/.test(base)) return `${asset.id.slice(0, 8)}-${base}`;
  return `${asset.id.slice(0, 8)}-${base}${EXTENSIONS[asset.mimeType] ?? (asset.mimeType.startsWith('image/') ? '.jpg' : '.mp4')}`;
}

export function planExport(renders: readonly RenderLike[], assets: readonly AssetLike[]): ExportItem[] {
  const videos = renders
    .filter((render) => render.status === 'done' && render.outputUrl)
    .map((render): ExportItem => ({ kind: 'video', id: render.id, url: render.outputUrl as string, fileName: `editify-${render.id}.mp4` }));
  const originals = assets
    .filter(savable)
    .map((asset): ExportItem => ({ kind: 'original', id: asset.id, url: asset.originalUrl, fileName: fileNameFor(asset) }));
  return [...videos, ...originals];
}

export interface ExportResult {
  /** Saved to Photos this session, earlier runs included. */
  saved: number;
  /** Failed on the latest run; a retry only tries these (and anything new). */
  failed: number;
  /** Every item the account has to save. */
  total: number;
}

/**
 * Stable across listings, unlike the URL: a render or asset id never changes,
 * so an item saved once is recognised on the next run.
 */
export function exportKey(item: Pick<ExportItem, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

/**
 * What a run should still save. Photos has no "already there" check of its
 * own, so re-saving an item duplicates it: after a partial failure the retry
 * must skip everything that already made it.
 */
export function remainingItems(items: readonly ExportItem[], saved: ReadonlySet<string>): ExportItem[] {
  return items.filter((item) => !saved.has(exportKey(item)));
}

/** The sunset screen's button: retry names how many failed, and a finished export does not offer to save it all again. */
export function exportButton(running: boolean, result: ExportResult | undefined): { label: string; disabled: boolean } {
  if (running) return { label: 'Saving to Photos…', disabled: true };
  if (result && result.failed > 0) return { label: `Retry ${result.failed} failed`, disabled: false };
  if (result && result.total > 0 && result.saved >= result.total) return { label: 'All saved to Photos', disabled: true };
  return { label: 'Save my videos to Photos', disabled: false };
}
