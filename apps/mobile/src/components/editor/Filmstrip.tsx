import { memo, useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { AssetMetadata } from '@editify/shared';
import { assetFilmstripUrl, assetThumbUrl } from '../../lib/api';
import { FILMSTRIP_TILES, stripCells } from '../../lib/timeline';
import { colors } from '../../lib/theme';

interface Props {
  asset: AssetMetadata | undefined;
  /** Source range shown by the clip, in seconds. */
  in: number;
  out: number;
  width: number;
  height: number;
}

/**
 * Filmstrip background for a timeline clip.
 *
 * `GET /assets/:id/filmstrip.jpg` tiles 20 frames left→right across the whole
 * asset. Each visible cell is a window onto the tile nearest that cell's source
 * time — cropping with `overflow: hidden` plus a negative offset — so trimming a
 * clip re-frames the strip instead of squashing it. If the endpoint is not
 * there yet (404) the whole strip degrades to the single `thumb.jpg`.
 */
export const Filmstrip = memo(function Filmstrip({ asset, in: inPoint, out, width, height }: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset?.id]);

  if (!asset || width <= 1) return <View style={[styles.blank, { height }]} />;
  if (failed) {
    return <Image source={{ uri: assetThumbUrl(asset.id) }} style={[styles.fallback, { width, height }]} resizeMode="cover" />;
  }

  const uri = assetFilmstripUrl(asset.id);
  const { cells, cellWidth } = stripCells({
    width,
    height,
    clip: { id: asset.id, start: 0, in: inPoint, out },
    assetDuration: asset.duration,
    assetAspect: asset.height > 0 ? asset.width / asset.height : 16 / 9,
  });

  return (
    <View style={[styles.row, { width, height }]} pointerEvents="none">
      {cells.map((cell, index) => (
        <View key={`${cell.key}-${index}`} style={{ width: cellWidth, height, overflow: 'hidden' }}>
          <Image
            source={{ uri }}
            style={{ width: cellWidth * FILMSTRIP_TILES, height, marginLeft: -cell.tile * cellWidth }}
            resizeMode="stretch"
            onError={() => setFailed(true)}
          />
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', backgroundColor: '#000000' },
  blank: { flex: 1, backgroundColor: colors.panelRaised },
  fallback: { opacity: 0.85 },
});
