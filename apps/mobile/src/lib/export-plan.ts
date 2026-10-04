/**
 * What the sunset screen saves to Photos: the newest finished master of each
 * project, then every original the user uploaded. Pure, so it is tested
 * without a device; `photo-export.ts` does the downloading and saving.
 */

export interface ExportItem {
  kind: 'video' | 'original';
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
    .map((render): ExportItem => ({ kind: 'video', url: render.outputUrl as string, fileName: `editify-${render.id}.mp4` }));
  const originals = assets
    .filter(savable)
    .map((asset): ExportItem => ({ kind: 'original', url: asset.originalUrl, fileName: fileNameFor(asset) }));
  return [...videos, ...originals];
}
