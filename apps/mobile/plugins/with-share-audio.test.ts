import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { patchShareController, MARKER } = require('./with-share-audio.js') as {
  patchShareController: (source: string) => string;
  MARKER: string;
};

/** The two spots expo-share-intent's ShareViewController.swift is patched at, with just enough around them. */
const UPSTREAM = `
      for (index, attachment) in (attachments).enumerated() {
        if attachment.hasItemConformingToTypeIdentifier(imageContentType) {
          await handleImages(content: content, attachment: attachment, index: index)
        } else if attachment.hasItemConformingToTypeIdentifier(fileURLType) {
          await handleFiles(content: content, attachment: attachment, index: index)
        }
      }

  private func handleFiles(content: NSExtensionItem, attachment: NSItemProvider, index: Int) async {
  }
`;

describe('patchShareController', () => {
  it('routes audio attachments to an audio handler ahead of the file-URL branch', () => {
    const patched = patchShareController(UPSTREAM);
    const audioBranch = patched.indexOf('hasItemConformingToTypeIdentifier(UTType.audio.identifier)');
    const fileBranch = patched.indexOf('hasItemConformingToTypeIdentifier(fileURLType)');
    expect(audioBranch).toBeGreaterThan(-1);
    // Before the file branch: a memo that is also a file URL must still be read as audio.
    expect(audioBranch).toBeLessThan(fileBranch);
    expect(patched).toContain('private func handleAudio(');
    expect(patched).toContain(MARKER);
  });

  it('leaves an already-patched controller alone, so a second prebuild does not add the branch twice', () => {
    const once = patchShareController(UPSTREAM);
    expect(patchShareController(once)).toBe(once);
  });

  it('fails the prebuild when the library moves its code, rather than ship an extension that drops memos', () => {
    expect(() => patchShareController('class ShareViewController {}')).toThrow(/update the audio branch anchors/);
  });
});
