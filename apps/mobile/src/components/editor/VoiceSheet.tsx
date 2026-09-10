import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder,
} from 'expo-audio';
import type { AssetMetadata } from '@editify/shared';
import { uploadAsset } from '../../lib/api';
import { colors, radius, space, type, fonts } from '../../lib/theme';

interface Props {
  projectId: string;
  visible: boolean;
  onClose: () => void;
  /** Called with the uploaded recording; the project screen drops it at the playhead with duck: true. */
  onRecorded: (asset: AssetMetadata) => void;
}

/** Native writes the preset's AAC/.m4a container; on web MediaRecorder hands back WebM/Opus. */
const CAPTURE = Platform.OS === 'web'
  ? { extension: 'webm', mimeType: 'audio/webm' }
  : { extension: 'm4a', mimeType: 'audio/mp4' };

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** Voiceover recorder: mic capture, upload, then a ducked clip at the playhead. */
export function VoiceSheet({ projectId, visible, onClose, onRecorded }: Props) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [stage, setStage] = useState<'idle' | 'recording' | 'uploading'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string>();
  const startedAt = useRef(0);

  // The elapsed readout is pure chrome, so it runs off the wall clock rather
  // than a second subscription to the recorder's own status stream.
  useEffect(() => {
    if (stage !== 'recording') return undefined;
    const tick = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 100);
    return () => clearInterval(tick);
  }, [stage]);

  async function start(): Promise<void> {
    setError(undefined);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError('No microphone access. Allow it for this app, then try again.');
        return;
      }
      // iOS needs the session put into record mode; a no-op on web.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt.current = Date.now();
      setElapsed(0);
      setStage('recording');
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not open the microphone');
      setStage('idle');
    }
  }

  async function stop(): Promise<void> {
    setStage('uploading');
    let uri: string | null;
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      uri = recorder.uri;
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'Could not stop the recording');
      setStage('idle');
      return;
    }
    if (!uri) {
      setError('The recording came back empty');
      setStage('idle');
      return;
    }
    try {
      const asset = await uploadAsset({
        uri,
        name: `voiceover-${Date.now()}.${CAPTURE.extension}`,
        mimeType: CAPTURE.mimeType,
        projectId,
      });
      setStage('idle');
      setElapsed(0);
      onRecorded(asset);
      onClose();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed');
      setStage('idle');
    }
  }

  /** Closing mid-take throws the take away: the mic is released, nothing uploads. */
  function close(): void {
    // Close FIRST — a sheet stuck open is worse than a stray recorder — then let
    // the in-flight recording end without ever reaching the upload.
    onClose();
    if (stage === 'recording') {
      void recorder.stop().catch(() => undefined);
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
    setStage('idle');
    setElapsed(0);
    setError(undefined);
  }

  const recording = stage === 'recording';
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>VOICEOVER</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="close" hitSlop={10} onPress={close}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>lands at the playhead · everything else ducks under it</Text>
          <View style={styles.stage}>
            <Text style={[styles.timer, recording && styles.timerLive]}>{clock(elapsed)}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={recording ? 'stop recording' : 'start recording'}
              disabled={stage === 'uploading'}
              onPress={() => void (recording ? stop() : start())}
              style={({ pressed }) => [
                styles.button,
                recording && styles.buttonLive,
                pressed && styles.pressed,
                stage === 'uploading' && styles.disabled,
              ]}
            >
              <View style={recording ? styles.stopIcon : styles.recordIcon} />
            </Pressable>
            <Text style={styles.caption}>
              {stage === 'uploading' ? 'uploading…' : recording ? 'tap to stop' : 'tap to record'}
            </Text>
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000AA' },
  sheet: {
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.panel, padding: space.xxl, gap: space.lg,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  close: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.xl, padding: space.sm },
  subtitle: { color: colors.muted, fontFamily: fonts.regular, fontSize: type.sm },
  stage: { alignItems: 'center', gap: space.xl, paddingVertical: space.xxl },
  timer: {
    color: colors.muted, fontFamily: fonts.bold, fontSize: type.display, letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  timerLive: { color: colors.text },
  button: {
    width: 64, height: 64, borderRadius: radius.full, borderWidth: 2, borderColor: colors.border,
    backgroundColor: colors.panelRaised, alignItems: 'center', justifyContent: 'center',
  },
  buttonLive: { borderColor: colors.danger },
  recordIcon: { width: 36, height: 36, borderRadius: radius.full, backgroundColor: colors.danger },
  stopIcon: { width: 24, height: 24, borderRadius: radius.sm, backgroundColor: colors.danger },
  caption: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.md },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.md, paddingBottom: space.sm },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.65 },
});
