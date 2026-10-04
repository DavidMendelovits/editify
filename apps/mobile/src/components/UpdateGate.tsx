import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Brand } from './Brand';
import { Button } from './Button';
import { ProgressBar } from './ProgressBar';
import { Screen } from './Screen';
import { osLabel, type Gate } from '../lib/client-config';
import { track } from '../lib/event-log';
import { exportButton } from '../lib/export-plan';
import { exportToPhotos, type ExportProgress, type ExportResult } from '../lib/photo-export';
import { supabase } from '../lib/supabase';
import { colors, fonts, radius, space, type } from '../lib/theme';
import { appVersion } from '../lib/version';

/**
 * Full screen, in place of the whole app, when this build is below the
 * server's floor. `update` sends the user to the App Store. `sunset` is for a
 * phone whose iOS cannot run the new version: there is nothing to update to,
 * so the one useful thing left is getting their videos out.
 */
export function UpdateGate({ gate }: { gate: Exclude<Gate, { kind: 'none' }> }) {
  return (
    <Screen>
      <View style={styles.brand}><Brand /></View>
      <View style={styles.shell}>
        {gate.kind === 'update' ? <UpdateCard storeUrl={gate.storeUrl} /> : <SunsetCard latestVersion={gate.latestVersion} minOs={gate.minOs} />}
        <Text style={styles.version}>{appVersion}</Text>
      </View>
    </Screen>
  );
}

function UpdateCard({ storeUrl }: { storeUrl: string }) {
  return (
    <>
      <View style={styles.intro}>
        <Text style={styles.title}>Update Editify</Text>
        <Text style={styles.body}>This version is no longer supported. Update from the App Store to keep editing. Your projects come with you.</Text>
      </View>
      <Button accessibilityLabel="open the App Store" onPress={() => void Linking.openURL(storeUrl)}>
        Update on the App Store
      </Button>
    </>
  );
}

function SunsetCard({ latestVersion, minOs }: { latestVersion: string; minOs: string }) {
  const [progress, setProgress] = useState<ExportProgress>();
  const [result, setResult] = useState<ExportResult>();
  const [error, setError] = useState<string>();
  const running = progress !== undefined && result === undefined && error === undefined;
  const button = exportButton(running, result);
  const current = typeof Platform.Version === 'string' ? Platform.Version : String(Platform.Version);

  async function run(): Promise<void> {
    setResult(undefined);
    setError(undefined);
    setProgress({ done: 0, total: 0 });
    try {
      setResult(await exportToPhotos(setProgress));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Saving to Photos failed. Please try again.';
      track('photo_export_failed', message);
      setError(message);
    }
  }

  return (
    <>
      <View style={styles.intro}>
        <Text style={styles.title}>Editify {latestVersion} needs iOS {osLabel(minOs)}</Text>
        <Text style={styles.body}>
          This iPhone runs iOS {current}, so it cannot install the new version. Editify 1.0 keeps your projects for 30 days
          after this update. Save your finished videos and the clips you uploaded to Photos before then.
        </Text>
      </View>
      <View style={styles.card}>
        <Button accessibilityLabel={button.label} onPress={() => void run()} disabled={button.disabled}>
          {button.label}
        </Button>
        {progress && progress.total > 0 && (
          <View style={styles.progress}>
            <ProgressBar fraction={progress.done / progress.total} />
            <Text style={styles.label}>{progress.done} OF {progress.total}</Text>
          </View>
        )}
        {result && (
          <Text style={result.failed ? styles.warn : styles.notice}>
            {result.total === 0
              ? 'There was nothing to save: no finished videos or uploaded clips on this account.'
              : `Saved ${result.saved} of ${result.total} to Photos.${result.failed ? ` ${result.failed} could not be saved; try again on Wi-Fi.` : ''}`}
          </Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
      {/* A shared phone, or the wrong account: signing out drops the gate to sign-in, and the next account meets it again. */}
      <Pressable accessibilityRole="button" accessibilityLabel="sign out" hitSlop={12} disabled={running} onPress={() => { void supabase.auth.signOut(); }} style={styles.signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  brand: { minHeight: 58, justifyContent: 'center' },
  shell: { flex: 1, width: '100%', maxWidth: 460, alignSelf: 'center', justifyContent: 'center', gap: space.section, paddingVertical: space.section },
  intro: { alignItems: 'center', gap: space.lg },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: type.display, lineHeight: 34, letterSpacing: -0.8, textAlign: 'center' },
  body: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.xl, lineHeight: 20, textAlign: 'center' },
  card: { gap: space.xl, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: space.xxl },
  progress: { gap: space.md },
  label: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1.5 },
  notice: { color: colors.success, fontFamily: fonts.medium, fontSize: type.lg, lineHeight: 18 },
  warn: { color: colors.warn, fontFamily: fonts.medium, fontSize: type.lg, lineHeight: 18 },
  error: { color: colors.danger, fontFamily: fonts.medium, fontSize: type.lg, lineHeight: 18 },
  signOut: { alignSelf: 'center', paddingVertical: space.sm, paddingHorizontal: space.lg },
  signOutText: { color: colors.muted, fontFamily: fonts.medium, fontSize: type.lg, textDecorationLine: 'underline' },
  version: { color: colors.muted, fontFamily: fonts.mono, fontSize: type.sm, letterSpacing: 1, textAlign: 'center' },
});
