import { DEFAULT_SETTINGS } from './domain.ts';
import type { DailyRecord, Settings } from './domain.ts';
import { compatibleTrades } from './trading.ts';
import type { TradeImage, TradeRecord } from './trading.ts';
import { buildReviewData, reviewRange } from './review-data.ts';
import type { ReviewQuery } from './review-data.ts';

// A single read-only batch sees the same D1 snapshot. Never includes drafts,
// history backups, credentials, or another owner's records.
export async function readReview(db: D1Database, owner: string, query: ReviewQuery, now = new Date()) {
  reviewRange(query, now);
  const rows = await db.batch([
    db.prepare('SELECT date, data, updated_at FROM daily_records WHERE owner_id = ? ORDER BY date').bind(owner),
    db.prepare('SELECT data, updated_at FROM user_settings WHERE owner_id = ?').bind(owner),
    db.prepare('SELECT id, data, revision, updated_at FROM trade_records WHERE owner_id = ? ORDER BY id').bind(owner),
    db.prepare('SELECT id, data, updated_at FROM trade_images WHERE owner_id = ? ORDER BY id').bind(owner),
  ]);
  if (rows.some(r => !r.success)) throw new Error('D1 read failed');
  type Stored = { data: string; revision?: number; updated_at: string };
  const daily = (rows[0].results ?? []) as unknown as Stored[];
  const settings = (rows[1].results ?? []) as unknown as Stored[];
  const trades = (rows[2].results ?? []) as unknown as Stored[];
  const images = (rows[3].results ?? []) as unknown as Stored[];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows.map(r => r.results))));
  const dataVersion = 'sha256:' + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  const lastUpdatedAt = [...daily, ...settings, ...trades, ...images].map(r => r.updated_at).filter(Boolean).sort().at(-1) ?? null;
  const records = daily.map(r => JSON.parse(r.data) as DailyRecord);
  return buildReviewData({
    records,
    settings: settings.length ? JSON.parse(settings[0].data) as Settings : DEFAULT_SETTINGS,
    trades: compatibleTrades(records, trades.map(r => ({ ...JSON.parse(r.data), revision: r.revision }) as TradeRecord)),
    images: images.map(r => JSON.parse(r.data) as TradeImage),
    dataVersion,
    lastUpdatedAt,
  }, query, now);
}
