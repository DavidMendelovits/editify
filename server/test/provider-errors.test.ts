import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicToolProvider } from '../src/agent/providers.js';

const realFetch = globalThis.fetch;

function stubFetch(status: number, body: string): void {
  globalThis.fetch = vi.fn(async () => new Response(body, { status })) as typeof fetch;
}

afterEach(() => { globalThis.fetch = realFetch; });

async function messageFor(provider: { completeText(system: string, user: string): Promise<string> }): Promise<string> {
  return await provider.completeText('system', 'hi').then(() => '', (error: unknown) => (error as Error).message);
}

describe('provider failure messages', () => {
  const authBody = '{"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}';

  it('turns an Anthropic 401 into plain English naming ANTHROPIC_API_KEY', async () => {
    stubFetch(401, authBody);
    const message = await messageFor(new AnthropicToolProvider('bad-key'));
    expect(message).toBe('Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY on the server.');
    expect(message).not.toContain('authentication_error');
    expect(message).not.toContain('{');
  });

  it('explains a 429 as rate limiting', async () => {
    stubFetch(429, '{"error":"slow down"}');
    expect(await messageFor(new AnthropicToolProvider('key')))
      .toBe('Anthropic is rate limiting this server (429). Wait a moment and try again.');
  });

  it('explains a 500 as the vendor being down', async () => {
    stubFetch(500, '<html>upstream exploded</html>');
    expect(await messageFor(new AnthropicToolProvider('key')))
      .toBe('Anthropic is unavailable right now (500). Try again in a moment.');
  });

  it('still surfaces the status and a trimmed body for other statuses', async () => {
    stubFetch(400, `{"padding":"${'x'.repeat(500)}"}`);
    const message = await messageFor(new AnthropicToolProvider('key'));
    expect(message).toContain('Anthropic request failed (400)');
    expect(message.length).toBeLessThan(260);
    expect(message.endsWith('…')).toBe(true);
  });
});
