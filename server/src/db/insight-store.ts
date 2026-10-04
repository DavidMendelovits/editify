import { assetInsightsSchema, type AssetInsights } from '@editify/shared';
import type { EditifyDatabase } from './database.js';

export class InsightStore {
  constructor(private readonly database: EditifyDatabase) {}

  get(assetId: string): AssetInsights | undefined {
    const row = this.database.prepare('SELECT json FROM insights WHERE asset_id = ?')
      .get(assetId) as { json: string } | undefined;
    return row ? assetInsightsSchema.parse(JSON.parse(row.json)) : undefined;
  }

  put(insights: AssetInsights): AssetInsights {
    const parsed = assetInsightsSchema.parse(insights);
    // Read-only (the cutover freeze): serve it, store nothing.
    if (this.database.readonly) return parsed;
    this.database.prepare(`
      INSERT INTO insights (asset_id, json, created_at) VALUES (?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at
    `).run(parsed.assetId, JSON.stringify(parsed), parsed.generatedAt);
    return parsed;
  }
}
