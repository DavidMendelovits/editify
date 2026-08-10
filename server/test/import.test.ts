import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/database.js';

describe('local media import', () => {
  it('rejects path traversal', async () => {
    const app = await buildApp({ database: createDatabase(':memory:') });
    const response = await app.inject({
      method: 'POST',
      url: '/assets/import',
      payload: { name: '../secret' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
