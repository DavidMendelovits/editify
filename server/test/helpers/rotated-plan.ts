import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRenderPlan, type PlanAssetInfo, type Project, type RenderPlan } from '@editify/shared';

/*
 * The export harness's rotated-source plan (parity/export/plans/rotated-broll.json),
 * built by buildRenderPlan from the geometry the phone reports for a portrait phone clip:
 * stored 640 x 360 with a 90 degree display rotation (what an iPhone writes), the way
 * device-export.ts's assetInfoOf passes it. The server's asset record would say 640 x 360
 * and nothing more, which lays the clip out sideways.
 *
 * The clip plays as the main layer with a punch-in to the top-left corner (an animated
 * zoom whose crop keys depend on the upright size) and again as a picture-in-picture
 * b-roll box (whose shape depends on it).
 *
 *   npx tsx server/test/helpers/rotated-plan.ts   # rewrite the committed plan
 *
 * server/test/device-export.test.ts checks the committed file is what this builds.
 */
export const ROTATED_PLAN_FILE = fileURLToPath(new URL('../../../apps/mobile/modules/editify-engine/parity/export/plans/rotated-broll.json', import.meta.url));

/** Stored size and rotation, as MediaGeometry reports it on the phone. */
export const PORTRAIT_CLIP: PlanAssetInfo = { kind: 'video', width: 640, height: 360, rotation: 90, duration: 4, hasAudio: false, fps: 30 };

export const ROTATED_PROJECT: Project = {
  id: 'rotated', title: 'Rotated', format: '9:16', fps: 30, duration: 3, version: 1,
  tracks: [
    { id: 'v', kind: 'video', clips: [{
      id: 'main', assetId: 'asset-portrait', start: 0, in: 0, out: 3,
      transform: { scale: 1, x: 0, y: 0 }, transformEnd: { scale: 1.5, x: -1, y: -1 },
    }] },
    { id: 'o', kind: 'overlay', clips: [{ id: 'pip', assetId: 'asset-portrait', start: 0, in: 0, out: 3, overlay: { x: 0.72, y: 0.72, width: 0.4, rotation: 0 } }] },
  ],
};

export function buildRotatedPlan(info: PlanAssetInfo = PORTRAIT_CLIP): RenderPlan {
  return buildRenderPlan(ROTATED_PROJECT, { kind: 'export', size: { w: 360, h: 640 }, color: 'sdr', loudness: false }, {
    revision: 1, buildSeq: 1, assetInfo: (id) => (id === 'asset-portrait' ? info : undefined),
  });
}

export const ROTATED_DESCRIPTION = 'Export harness: a portrait phone clip stored 640 x 360 with a 90 degree display rotation, as the main layer with a punch-in to its top-left corner and as a picture-in-picture b-roll box, built from the geometry the phone reports.';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(ROTATED_PLAN_FILE, `${JSON.stringify({ description: ROTATED_DESCRIPTION, plan: buildRotatedPlan() }, null, 2)}\n`);
}
