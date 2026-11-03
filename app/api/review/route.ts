import { calendarDate } from '../../../lib/trading';
import { readReview } from '../../../lib/review-repository';
import { apiError, privateContext, privateJSON } from '../private-api';
import { RecordError } from '../../../lib/trade-repository';
import type { ReviewQuery } from '../../../lib/review-data';
import { reviewRange } from '../../../lib/review-data';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { user, db } = await privateContext();
    const p = new URL(request.url).searchParams;
    if ([...p.keys()].some(k => !['scope', 'start', 'end', 'instrument', 'accountId'].includes(k)) || [...new Set(p.keys())].some(key => p.getAll(key).length > 1)) throw new RecordError('查询参数无效。');
    const scope = p.get('scope') ?? 'today';
    if (!['today', 'positions', 'range'].includes(scope)) throw new RecordError('复盘范围无效。');
    const start = p.get('start') ?? undefined, end = p.get('end') ?? undefined;
    if (!!start !== !!end || start && (!calendarDate.safeParse(start).success || !calendarDate.safeParse(end).success || start > end!)) throw new RecordError('请填写有效的起止日期。');
    if (scope !== 'range' && (start || end)) throw new RecordError('只有区间复盘可以指定起止日期。');
    const query = { scope, start, end, instrument: p.get('instrument') ?? undefined, accountId: p.get('accountId') ?? undefined } as ReviewQuery;
    try { reviewRange(query); } catch (e) { throw new RecordError((e as Error).message); }
    return privateJSON(await readReview(db, user.userId, query));
  } catch (e) { return apiError(e); }
}
