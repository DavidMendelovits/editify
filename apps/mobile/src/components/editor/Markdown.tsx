import { memo, useMemo, type ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type, fonts } from '../../lib/theme';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
// Order matters: `**` must be tried before `*`.
const INLINE = /`[^`\n]+`|\*\*[^\n]+?\*\*|\*[^*\n]+?\*|\[[^\]\n]*\]\([^)\s]+\)/g;

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'item'; marker: string; indent: number; text: string }
  | { kind: 'para'; text: string };

/**
 * Line-based markdown split. Runs on every render of a streaming message, so it
 * stays a single pass with one bit of state (the open code fence).
 * ponytail: tables, images, and blockquotes are not parsed — those lines land in
 * paragraphs and render as plain text.
 */
function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let code: string[] | undefined;
  let para: string[] = [];

  function flush(): void {
    if (para.length === 0) return;
    blocks.push({ kind: 'para', text: para.join(' ') });
    para = [];
  }

  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (code) blocks.push({ kind: 'code', text: code.join('\n') });
      else flush();
      code = code ? undefined : [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const [, hashes = '', text = ''] = heading;
      blocks.push({ kind: 'heading', level: hashes.length, text });
      continue;
    }
    // ponytail: one nesting level — anything indented at all is treated as depth 1.
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const [, space = '', text = ''] = bullet;
      blocks.push({ kind: 'item', marker: '•', indent: space.length > 0 ? 1 : 0, text });
      continue;
    }
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flush();
      const [, space = '', number = '', text = ''] = ordered;
      blocks.push({ kind: 'item', marker: `${number}.`, indent: space.length > 0 ? 1 : 0, text });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  // A fence still open mid-stream renders as a code block instead of vanishing.
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  return blocks;
}

/**
 * Inline spans inside one block. ponytail: spans do not nest — the body of a
 * bold/italic/link run is rendered as plain text.
 */
function renderInline(source: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(source); match; match = INLINE.exec(source)) {
    if (match.index > last) out.push(source.slice(last, match.index));
    const token = match[0];
    const id = `${key}-${match.index}`;
    if (token.startsWith('`')) {
      out.push(<Text key={id} style={styles.inlineCode}>{token.slice(1, -1)}</Text>);
    } else if (token.startsWith('**')) {
      out.push(<Text key={id} style={styles.bold}>{token.slice(2, -2)}</Text>);
    } else if (token.startsWith('*')) {
      out.push(<Text key={id} style={styles.italic}>{token.slice(1, -1)}</Text>);
    } else {
      const split = token.indexOf('](');
      const url = token.slice(split + 2, -1);
      out.push(
        <Text key={id} style={styles.link} onPress={() => void Linking.openURL(url)}>{token.slice(1, split)}</Text>,
      );
    }
    last = match.index + token.length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `b${index}`;
  if (block.kind === 'code') {
    return (
      <View key={key} style={styles.codeBlock}>
        <Text style={styles.codeBlockText}>{block.text}</Text>
      </View>
    );
  }
  if (block.kind === 'heading') {
    const style = block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
    return <Text key={key} style={style}>{renderInline(block.text, key)}</Text>;
  }
  if (block.kind === 'item') {
    return (
      <View key={key} style={[styles.item, block.indent > 0 && styles.itemNested]}>
        <Text style={styles.itemMarker}>{block.marker}</Text>
        <Text style={styles.text}>{renderInline(block.text, key)}</Text>
      </View>
    );
  }
  return <Text key={key} style={styles.text}>{renderInline(block.text, key)}</Text>;
}

/** Markdown-ish renderer for assistant chat turns; memoized on the raw text so streaming re-renders are cheap. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <View style={styles.body}>{blocks.map(renderBlock)}</View>;
});

const styles = StyleSheet.create({
  body: { gap: space.sm },
  text: { flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: type.lg, lineHeight: 18 },
  bold: { fontFamily: fonts.bold },
  italic: { fontStyle: 'italic' },
  link: { color: colors.accent, textDecorationLine: 'underline' },
  h1: { color: colors.text, fontFamily: fonts.bold, fontSize: type.xl, lineHeight: 20, marginTop: space.xs },
  h2: { color: colors.text, fontFamily: fonts.bold, fontSize: type.lg, lineHeight: 18, marginTop: space.xs },
  h3: { color: colors.muted, fontFamily: fonts.bold, fontSize: type.base, lineHeight: 16, letterSpacing: 0.5, marginTop: space.xs },
  item: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  itemNested: { paddingLeft: space.xl },
  itemMarker: { minWidth: 12, color: colors.muted, fontFamily: fonts.semibold, fontSize: type.base, lineHeight: 18 },
  inlineCode: { color: colors.text, fontFamily: MONO, fontSize: type.base, backgroundColor: colors.panelRaised },
  codeBlock: { borderRadius: radius.md, backgroundColor: colors.panelSunken, padding: space.lg },
  codeBlockText: { color: colors.text, fontFamily: MONO, fontSize: type.base, lineHeight: 16 },
});
