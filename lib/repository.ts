import type { DailyRecord, Settings } from './domain';
export async function loadData(db:D1Database, owner:string) {
  const [days, settings] = await Promise.all([
    db.prepare('SELECT data FROM daily_records WHERE owner_id = ? ORDER BY date').bind(owner).all<{data:string}>(),
    db.prepare('SELECT data FROM user_settings WHERE owner_id = ?').bind(owner).first<{data:string}>(),
  ]);
  return { records:(days.results??[]).map(d=>JSON.parse(d.data) as DailyRecord), settings:settings?JSON.parse(settings.data) as Settings:null };
}
export async function saveRecord(db:D1Database,owner:string,record:DailyRecord) {
  await db.prepare('INSERT INTO daily_records (owner_id, date, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id,date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(owner,record.date,JSON.stringify(record),new Date().toISOString()).run();
  await deleteDraft(db,owner,record.date);
}
export async function deleteRecord(db:D1Database,owner:string,date:string) { await db.prepare('DELETE FROM daily_records WHERE owner_id = ? AND date = ?').bind(owner,date).run(); }
export async function saveSettings(db:D1Database,owner:string,settings:Settings) { await db.prepare('INSERT INTO user_settings (owner_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(owner,JSON.stringify(settings),new Date().toISOString()).run(); }
export type DailyDraft = {record:DailyRecord;updatedAt:string};
export async function loadDrafts(db:D1Database,owner:string):Promise<DailyDraft[]> {
  const rows=await db.prepare('SELECT d.data, d.updated_at FROM daily_drafts d LEFT JOIN daily_records r ON r.owner_id = d.owner_id AND r.date = d.date WHERE d.owner_id = ? AND (r.updated_at IS NULL OR d.updated_at > r.updated_at) ORDER BY d.date').bind(owner).all<{data:string;updated_at:string}>();
  return (rows.results??[]).map(d=>({record:JSON.parse(d.data) as DailyRecord,updatedAt:d.updated_at}));
}
export async function loadDraft(db:D1Database,owner:string,date:string):Promise<DailyDraft|null> {
  const row=await db.prepare('SELECT d.data, d.updated_at FROM daily_drafts d LEFT JOIN daily_records r ON r.owner_id = d.owner_id AND r.date = d.date WHERE d.owner_id = ? AND d.date = ? AND (r.updated_at IS NULL OR d.updated_at > r.updated_at)').bind(owner,date).first<{data:string;updated_at:string}>();
  return row?{record:JSON.parse(row.data) as DailyRecord,updatedAt:row.updated_at}:null;
}
export async function saveDraft(db:D1Database,owner:string,record:DailyRecord) {
  await db.prepare('INSERT INTO daily_drafts (owner_id, date, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id,date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(owner,record.date,JSON.stringify(record),new Date().toISOString()).run();
}
export async function deleteDraft(db:D1Database,owner:string,date:string){await db.prepare('DELETE FROM daily_drafts WHERE owner_id = ? AND date = ?').bind(owner,date).run();}
