// expo-share-intent's iOS share extension routes each attachment by type:
// images, movies, vCards, file URLs, PDFs, URLs, text. Audio has no branch, and
// a Voice Memos recording can arrive typed only as com.apple.m4a-audio (a
// public.audio), so the stock controller falls through to its
// "content type not handle" alert and the share never reaches the app.
//
// This adds an audio branch ahead of the file-URL one and hands the recording
// to the extension's own file path, so it lands in the app like any other file.
// It runs as a finalized mod: the extension's Swift is written during the
// xcodeproj mod, and finalized mods run after every other.
const fs = require('node:fs');
const path = require('node:path');
const { withFinalizedMod } = require('expo/config-plugins');

const MARKER = '/* editify: audio branch */';
const DISPATCH_ANCHOR = '} else if attachment.hasItemConformingToTypeIdentifier(fileURLType) {';
const METHOD_ANCHOR = '  private func handleFiles(content: NSExtensionItem, attachment: NSItemProvider, index: Int) async {';

const HANDLE_AUDIO = `  ${MARKER}
  private func handleAudio(content: NSExtensionItem, attachment: NSItemProvider, index: Int) async {
    Task.detached {
      // Ask for the concrete type the sender registered (com.apple.m4a-audio,
      // public.mp3, ...): not every provider answers for the abstract parent.
      let audioType = attachment.registeredTypeIdentifiers.first {
        UTType($0)?.conforms(to: .audio) ?? false
      } ?? UTType.audio.identifier
      if let url = try? await attachment.loadItem(forTypeIdentifier: audioType) as? URL {
        Task { @MainActor in
          await self.handleFileURL(content: content, url: url, index: index)
        }
      } else if let data = try? await attachment.loadItem(forTypeIdentifier: audioType) as? Data {
        let fileExtension = UTType(audioType)?.preferredFilenameExtension ?? "m4a"
        let tmp = FileManager.default.temporaryDirectory
          .appendingPathComponent(UUID().uuidString + "." + fileExtension)
        do {
          try data.write(to: tmp)
          Task { @MainActor in
            await self.handleFileURL(content: content, url: tmp, index: index)
          }
        } catch {
          await self.dismissWithError(message: "Cannot save audio: \\(error.localizedDescription)")
        }
      } else {
        NSLog("[ERROR] Cannot load audio content !\\(String(describing: content))")
        await self.dismissWithError(message: "Cannot load audio content \\(String(describing: content))")
      }
    }
  }

`;

/** @param {import('expo/config').ExpoConfig} config */
module.exports = function withShareAudio(config, { extensionName = 'ShareExtension' } = {}) {
  return withFinalizedMod(config, [
    'ios',
    async (modConfig) => {
      const file = path.join(modConfig.modRequest.platformProjectRoot, extensionName, 'ShareViewController.swift');
      let source = await fs.promises.readFile(file, 'utf8');
      if (source.includes(MARKER)) return modConfig;
      // Fail the prebuild loudly rather than ship an extension that drops voice memos.
      if (!source.includes(DISPATCH_ANCHOR) || !source.includes(METHOD_ANCHOR)) {
        throw new Error('with-share-audio: expo-share-intent changed ShareViewController.swift; update the audio branch anchors');
      }
      source = source
        .replace(
          DISPATCH_ANCHOR,
          `} else if attachment.hasItemConformingToTypeIdentifier(UTType.audio.identifier) {\n          await handleAudio(content: content, attachment: attachment, index: index)\n        ${DISPATCH_ANCHOR}`,
        )
        .replace(METHOD_ANCHOR, `${HANDLE_AUDIO}${METHOD_ANCHOR}`);
      await fs.promises.writeFile(file, source);
      return modConfig;
    },
  ]);
};
