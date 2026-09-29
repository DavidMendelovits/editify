import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { scopeCacheTo } from './query-client';

describe('scopeCacheTo', () => {
  it('keeps the cache for the same user and drops it the moment the user changes', () => {
    const client = new QueryClient();
    scopeCacheTo('alice', client);
    client.setQueryData(['projects'], ['alice-project']);

    scopeCacheTo('alice', client);
    expect(client.getQueryData(['projects'])).toEqual(['alice-project']);

    scopeCacheTo(undefined, client); // signed out
    expect(client.getQueryData(['projects'])).toBeUndefined();

    client.setQueryData(['projects'], ['stale']);
    scopeCacheTo('bob', client);
    expect(client.getQueryData(['projects'])).toBeUndefined();
  });
});
