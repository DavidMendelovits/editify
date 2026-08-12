import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseCliTurn } from '../src/agent/providers.js';

describe('CLI provider reply parsing', () => {
  it('reads the JSON object out of fences and chatty preambles', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! Here you go:\n{"a":{"b":2}}\nHope that helps.')).toEqual({ a: { b: 2 } });
    // A brace inside a string must not close the object early.
    expect(extractJsonObject('{"a":"} not the end","b":1}')).toEqual({ a: '} not the end', b: 1 });
    expect(extractJsonObject('no json here')).toBeUndefined();
  });

  it('turns a well-formed reply into ids-assigned tool calls', () => {
    const turn = parseCliTurn('{"text":"working","toolCalls":[{"name":"get_project","input":{}},{"name":"close_gaps","input":{"trackId":"video-main"}}]}');
    expect(turn.text).toBe('working');
    expect(turn.toolCalls).toEqual([
      { id: 'cli-0', name: 'get_project', input: {} },
      { id: 'cli-1', name: 'close_gaps', input: { trackId: 'video-main' } },
    ]);
  });

  it('drops malformed calls and defaults a missing input', () => {
    const turn = parseCliTurn('{"toolCalls":[{"name":"get_project"},{"input":{}},"nope"]}');
    expect(turn.toolCalls).toEqual([{ id: 'cli-0', name: 'get_project', input: {} }]);
  });

  it('treats an unparseable reply as a final answer so the loop ends', () => {
    const turn = parseCliTurn('I could not do that.');
    expect(turn).toEqual({ text: 'I could not do that.', toolCalls: [] });
  });
});
