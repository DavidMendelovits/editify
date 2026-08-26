import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { AssetDissection, AssetMetadata } from '@editify/shared';
import { api } from '../lib/api';
import { colors } from '../lib/theme';

interface Props {
  assetIds: string[];
  assets: Record<string, AssetMetadata | undefined>;
}

/**
 * Measured dissection of source footage: cut cadence, audio energy, tempo,
 * and where burned-in graphics live. Everything is ffmpeg-derived server-side;
 * this panel draws it so a human can read a reference video's rhythm at a
 * glance — the same data the agent's `dissect_asset` tool consumes.
 */
export function DissectPanel({ assetIds, assets }: Props) {
  // Only videos are dissectable; sounds and sticker images have no cadence.
  const candidates = assetIds.filter((assetId) => {
    const asset = assets[assetId];
    return !asset || (asset.width > 0 && asset.height > 0 && !asset.mimeType.startsWith('image/'));
  });
  if (candidates.length === 0) return null;
  return (
    <View style={styles.panel}>
      <Text style={styles.zoneLabel}>DISSECTION</Text>
      <Text style={styles.subtitle}>measure a source video — cadence, sound, and overlays</Text>
      {candidates.map((assetId) => (
        <AssetDissectionRow key={assetId} assetId={assetId} asset={assets[assetId]} />
      ))}
    </View>
  );
}

function AssetDissectionRow({ assetId, asset }: { assetId: string; asset: AssetMetadata | undefined }) {
  const [requested, setRequested] = useState(false);
  const query = useQuery({
    queryKey: ['dissect', assetId],
    queryFn: () => api.dissect(assetId),
    enabled: requested,
    staleTime: Infinity,
    retry: false,
  });
  const name = (asset?.label ?? asset?.originalName ?? assetId).replace(/\.[^.]+$/, '');

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
        {!query.data && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`dissect ${name}`}
            hitSlop={8}
            disabled={query.isFetching}
            onPress={() => setRequested(true)}
            style={({ pressed }) => [styles.button, pressed && styles.pressed, query.isFetching && styles.disabled]}
          >
            <Text style={styles.buttonText}>{query.isFetching ? 'measuring…' : 'dissect'}</Text>
          </Pressable>
        )}
      </View>
      {query.isError && <Text style={styles.error}>{query.error.message}</Text>}
      {query.data && <DissectionBody dissection={query.data} />}
    </View>
  );
}

function DissectionBody({ dissection }: { dissection: AssetDissection }) {
  const duration = Math.max(dissection.duration, 0.01);
  return (
    <View style={styles.body}>
      <Text style={styles.summary}>{dissection.summary}</Text>
      <View style={styles.statRow}>
        <Stat label="CUTS" value={String(dissection.cuts.length)} />
        <Stat label="AVG SHOT" value={`${dissection.averageShotLength.toFixed(1)}s`} />
        <Stat label="TEMPO" value={dissection.tempoBpm ? `${dissection.tempoBpm} BPM` : '—'} />
        <Stat label="LOUDNESS" value={dissection.loudnessLufs !== null ? `${dissection.loudnessLufs.toFixed(0)} LUFS` : '—'} />
      </View>
      {/* Cut cadence: one tick per scene change across the source. */}
      <View style={styles.lane}>
        <Text style={styles.laneLabel}>CUTS</Text>
        <View style={styles.laneTrack}>
          {dissection.cuts.map((cut) => (
            <View key={cut} style={[styles.cutTick, { left: `${(cut / duration) * 100}%` }]} />
          ))}
        </View>
      </View>
      {/* Audio energy sparkline; peaks would land here as the loud moments. */}
      {dissection.energy.rmsDb.length > 1 && (
        <View style={styles.lane}>
          <Text style={styles.laneLabel}>ENERGY</Text>
          <View style={[styles.laneTrack, styles.energyTrack]}>
            {dissection.energy.rmsDb.map((db, index) => (
              <View
                key={index}
                style={[styles.energyBar, {
                  height: `${Math.round(energyPct(db) * 100)}%`,
                }]}
              />
            ))}
          </View>
        </View>
      )}
      {/* Where burned-in text/graphics sit, top vs bottom of frame. */}
      {dissection.overlayActivity.length > 0 && (
        <View style={styles.lane}>
          <Text style={styles.laneLabel}>GRAPHICS</Text>
          <View style={styles.laneTrack}>
            {dissection.overlayActivity.map((span, index) => (
              <View
                key={index}
                style={[
                  styles.overlaySpan,
                  span.zone === 'top' ? styles.overlayTop : styles.overlayBottom,
                  { left: `${(span.start / duration) * 100}%`, width: `${Math.max(1, ((span.end - span.start) / duration) * 100)}%` },
                ]}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

/** Map RMS dB (~-60..0) onto a 0..1 bar height. */
function energyPct(db: number): number {
  return Math.max(0.04, Math.min(1, (db + 60) / 60));
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel,
    padding: 12, gap: 8,
  },
  zoneLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 9, letterSpacing: 1.5 },
  subtitle: { color: colors.muted, fontFamily: 'Montserrat_400Regular', fontSize: 9 },
  row: { gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border },
  rowHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  rowName: { flex: 1, color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 11 },
  button: {
    minHeight: 30, borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panelRaised, paddingHorizontal: 12, justifyContent: 'center',
  },
  buttonText: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 10 },
  body: { gap: 6 },
  summary: { color: colors.text, fontFamily: 'Montserrat_500Medium', fontSize: 10, lineHeight: 15 },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  stat: { gap: 2 },
  statLabel: { color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 7, letterSpacing: 1 },
  statValue: { color: colors.text, fontFamily: 'Montserrat_600SemiBold', fontSize: 11, fontVariant: ['tabular-nums'] },
  lane: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  laneLabel: { width: 52, color: colors.muted, fontFamily: 'Montserrat_700Bold', fontSize: 7, letterSpacing: 1 },
  laneTrack: { flex: 1, height: 18, borderRadius: 4, backgroundColor: '#0D0D13', overflow: 'hidden' },
  cutTick: { position: 'absolute', top: 2, bottom: 2, width: 1, backgroundColor: colors.pink },
  energyTrack: { flexDirection: 'row', alignItems: 'flex-end' },
  energyBar: { flex: 1, backgroundColor: '#4C3E8F', marginRight: StyleSheet.hairlineWidth },
  overlaySpan: { position: 'absolute', height: 6, borderRadius: 2 },
  overlayTop: { top: 2, backgroundColor: '#C98A2B' },
  overlayBottom: { bottom: 2, backgroundColor: '#2E9E6B' },
  error: { color: colors.danger, fontFamily: 'Montserrat_500Medium', fontSize: 9 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.65 },
});
