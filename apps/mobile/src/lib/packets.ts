import { STYLE_PACKETS, type AssetDissection, type StylePacket } from '@editify/shared';
import type { StyleProfile } from './api';

/**
 * Session-only drafts derived from a dissection, written by the asset action
 * sheet and read by the style packet sheet through the shared query cache.
 */
export const PACKET_DRAFTS_KEY = ['packet-drafts'] as const;

/**
 * What a derived packet is before anything is measured. Only the fields the
 * source data actually supports get overridden — the rest ride these defaults,
 * so a half-measurable reference still yields a packet that applies cleanly.
 */
const BASE_PACKET: StylePacket = {
  id: 'derived',
  name: 'Derived look',
  description: 'Derived from measured footage.',
  typography: {
    sizePct: 4.2, color: '#FFFFFF', strokeColor: '#000000', strokePx: 3,
    anchorPct: 72, emphasis: 'none', uppercase: false, karaoke: false,
  },
  colors: { accent: '#8B5CF6' },
  music: { soundId: null, volume: 0.2 },
  transition: { type: 'cut', duration: 0.3, soundId: null, soundVolume: 0.5 },
  zoom: { cadence: 'off', scale: 1.06 },
  callouts: { density: 'off' },
  broll: { density: 'off' },
  pacing: { targetShotSeconds: null },
};

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] as number) : (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Fast cutting reads as hard cuts; anything slower gets a soft dissolve. */
function transitionFor(shotSeconds: number): StylePacket['transition'] {
  return shotSeconds < 2
    ? { ...BASE_PACKET.transition, type: 'cut', duration: 0.3 }
    : { ...BASE_PACKET.transition, type: 'crossfade', duration: 0.4 };
}

/**
 * A saved "learn my style" profile as a packet. The profile is ffmpeg
 * measurement — cut cadence, loudness, framing — so only pacing and the
 * transition habit follow from it.
 *
 * ponytail: typography, colour, and the music bed are not measured anywhere in
 * the profile, so they keep BASE_PACKET's defaults rather than being guessed.
 */
export function packetFromProfile(profile: StyleProfile): StylePacket | undefined {
  const shots = profile.metrics.map((metric) => metric.averageShotLength).filter((value) => value > 0);
  if (shots.length === 0) return undefined;
  const shot = median(shots);
  return {
    ...BASE_PACKET,
    id: `profile-${profile.id}`,
    name: 'My style',
    description: profile.styleDoc,
    transition: transitionFor(shot),
    pacing: { targetShotSeconds: round1(shot) },
  };
}

/**
 * A dissected reference video as a packet: median shot length sets the pacing
 * target and the transition guess, and where burned-in graphics sit sets where
 * captions anchor.
 *
 * ponytail: the dissection carries no motion/zoom measurement, so punch-in
 * cadence stays off; tempo and loudness are measured but there is no way to
 * pick a matching bed from them, so music stays silent.
 */
export function packetFromDissection(dissection: AssetDissection, label: string): StylePacket {
  const marks = [0, ...dissection.cuts, dissection.duration].filter((value) => value >= 0);
  const shots = marks.slice(1).map((mark, index) => mark - (marks[index] as number)).filter((length) => length > 0);
  const shot = shots.length ? median(shots) : dissection.averageShotLength;
  const bottom = dissection.overlayActivity.filter((span) => span.zone === 'bottom').length;
  const top = dissection.overlayActivity.length - bottom;
  return {
    ...BASE_PACKET,
    id: `dissect-${dissection.assetId}`,
    name: `Like ${label}`,
    description: dissection.summary,
    typography: {
      ...BASE_PACKET.typography,
      // Graphics sat low in frame, so captions do too; high, and they ride up.
      anchorPct: dissection.overlayActivity.length === 0 ? BASE_PACKET.typography.anchorPct : bottom >= top ? 78 : 22,
    },
    transition: transitionFor(shot),
    pacing: { targetShotSeconds: shot > 0 ? round1(shot) : null },
  };
}

/**
 * The chat message that applies one packet. Built-ins go by id; a derived
 * packet has no entry in the server's table, so it travels inline.
 */
export function packetPrompt(packet: StylePacket): string {
  const builtin = STYLE_PACKETS.some((candidate) => candidate.id === packet.id);
  const call = builtin
    ? `packetId "${packet.id}"`
    : `packet: ${JSON.stringify(packet)}`;
  return `Apply the "${packet.name}" style packet to this project — call apply_style_packet with ${call}. After the sweep, follow its guidance notes for callouts and b-roll where the footage supports them.`;
}

// ponytail: no packet fusion — blending two packets needs a rule per field
// (whose typography wins? do the beds stack?) and nobody has asked for it yet.
