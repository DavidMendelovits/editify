import { describe, expect, it } from 'vitest';
import { parseTranscriptInput } from '../src/agent/transcript-input.js';

describe('pasted transcript parsing', () => {
  it('parses SRT cues with numeric ids and comma decimals', () => {
    const result = parseTranscriptInput([
      '1',
      '00:00:01,000 --> 00:00:04,500',
      'Hello there,',
      'friend.',
      '',
      '2',
      '00:01:02,250 --> 00:01:05,000',
      'Second cue.',
      '',
    ].join('\n'));
    expect(result).toEqual({
      ok: true,
      format: 'srt',
      segments: [
        { start: 1, end: 4.5, text: 'Hello there, friend.' },
        { start: 62.25, end: 65, text: 'Second cue.' },
      ],
    });
  });

  it('parses VTT with a header, named cue ids, and cue settings', () => {
    const result = parseTranscriptInput([
      'WEBVTT',
      '',
      'intro',
      '00:00:01.000 --> 00:00:04.000 align:start position:10%',
      'The hook line.',
      '',
      '00:00:09.500 --> 00:00:12.000',
      'The payoff.',
    ].join('\n'));
    expect(result).toEqual({
      ok: true,
      format: 'vtt',
      segments: [
        { start: 1, end: 4, text: 'The hook line.' },
        { start: 9.5, end: 12, text: 'The payoff.' },
      ],
    });
  });

  it('parses timestamped plain text with bracket, paren, and bare prefixes', () => {
    const result = parseTranscriptInput([
      '[00:01:02.500] So here is the thing',
      'that carries onto a second line.',
      '(1:05) Quick aside.',
      '2:00 Back on topic.',
    ].join('\n'));
    expect(result).toEqual({
      ok: true,
      format: 'timestamped-text',
      segments: [
        { start: 62.5, end: null, text: 'So here is the thing that carries onto a second line.' },
        { start: 65, end: null, text: 'Quick aside.' },
        { start: 120, end: null, text: 'Back on topic.' },
      ],
    });
  });

  it('reports prose with no timecodes', () => {
    const result = parseTranscriptInput('So today we are talking about editing. It is a long story.');
    expect(result).toMatchObject({ ok: false, code: 'no-timecodes' });
    expect(result.ok ? '' : result.error).toContain('[00:01:02]');
  });

  it('reports empty input', () => {
    expect(parseTranscriptInput('   \n\n  ')).toMatchObject({ ok: false, code: 'empty' });
  });

  it('reports text that is neither prose nor timed', () => {
    expect(parseTranscriptInput('--- *** ---')).toMatchObject({ ok: false, code: 'unrecognized' });
  });
});
