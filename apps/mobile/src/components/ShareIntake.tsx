import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useShareIntentContext } from 'expo-share-intent';
import { api } from '../lib/api';
import { getActiveProject, isShareableMedia, queueShare, type SharedFile } from '../lib/share-intake';

/** "Voice Memo 42.m4a" → "Voice Memo 42": a project named after what started it. */
function titleFrom(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim();
  return (stem || 'Shared edit').slice(0, 120);
}

/**
 * Receives media from the OS share sheet and routes it: into the project whose
 * editor is open, or into a fresh project when none is. Renders nothing; the
 * editor does the upload so the import shows its usual progress and errors.
 */
export function ShareIntake({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const busy = useRef(false);

  useEffect(() => {
    // A share that arrives before sign-in waits for it: the intent stays put.
    if (!hasShareIntent || !signedIn || busy.current) return;
    const files: SharedFile[] = (shareIntent.files ?? [])
      .filter(isShareableMedia)
      .map((file) => ({ uri: file.path, name: file.fileName || 'shared', ...(file.mimeType ? { mimeType: file.mimeType } : {}) }));
    if (files.length === 0) {
      resetShareIntent();
      Alert.alert('Nothing to import', 'Editify takes videos and audio recordings from the share sheet.');
      return;
    }
    busy.current = true;
    void (async () => {
      try {
        const open = getActiveProject();
        if (open) {
          queueShare(open, files);
          return;
        }
        const project = await api.createProject({ title: titleFrom(files[0]?.name ?? ''), format: '9:16', fps: 30 });
        queueShare(project.id, files);
        await queryClient.invalidateQueries({ queryKey: ['projects'] });
        router.push({ pathname: '/project/[id]', params: { id: project.id } });
      } catch (error) {
        Alert.alert('Could not start a project', error instanceof Error ? error.message : String(error));
      } finally {
        resetShareIntent();
        busy.current = false;
      }
    })();
  }, [hasShareIntent, queryClient, resetShareIntent, router, shareIntent.files, signedIn]);

  return null;
}
