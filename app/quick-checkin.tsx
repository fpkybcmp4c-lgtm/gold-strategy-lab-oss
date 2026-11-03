'use client';
import React from 'react';
import type { DailyRecord, Settings } from '../lib/domain';
import { moneyFormat } from '../lib/domain';
import { dailySummaryDraft, derivedDaily } from '../lib/vnext-stats';
import type { TradeRecord } from '../lib/trading';
import { accountOf, assetTradeCurrency, INSTRUMENT_LABELS, INSTRUMENTS, instrumentOf, multiAssetSummary } from '../lib/multi-asset';
import { BufferedText } from './wellbeing-fields';
export const blankQuick = (): NonNullable<DailyRecord['quick']> => ({ market: null, structures: [], opportunity: null, discipline: null, emotions: [], energy: null, noTrade: false });
const markets = [['up', '上涨趋势'], ['down', '下跌趋势'], ['range', '震荡'], ['transition', '趋势转换'], ['uncertain', '不确定']] as const;
const structures = ['HH/HL', 'LH/LL', '回踩', '反弹', '突破', '假突破', '支撑测试', '阻力测试', '结构失效', '暂无明确结构'];
const emotions = ['平静', '情绪稳定', '自信', '过度自信', '兴奋', '焦虑', '恐惧', 'FOMO', '想回本', '急于交易', '疲劳', '烦躁', '无明显情绪', '其他'];
export const phrases = ['趋势未改变', '等待回踩确认', '反弹尚未结束', '关键阻力测试失败', '支撑有效', '假突破', '趋势转换中', '当前无有效Setup', '按计划持仓', '暂停新增仓位', '今日不交易'];
function Picks({ label, options, value, onChange, multi = false }: { label: string; options: readonly (readonly [string, string])[]; value: string | string[] | null; onChange: (v: string) => void; multi?: boolean }) {
  return <div className="quick-group"><span className="field-label">{label}{multi && <small>可多选</small>}</span><div className="quick-picks">{options.map(([v, l]) => <button type="button" key={v} aria-pressed={Array.isArray(value) ? value.includes(v) : value === v} className={(Array.isArray(value) ? value.includes(v) : value === v) ? 'selected' : ''} onClick={() => onChange(v)}>{l}</button>)}</div></div>;
}
const amount = (value: number | null) => value === null ? '未记录' : moneyFormat(value, 2);
const legacyGold = (trades: TradeRecord[]) => trades.filter(trade => instrumentOf(trade) === 'XAU' && accountOf(trade) === 'legacy');
export function scopedDailySummaryDraft(trades: TradeRecord[], day: DailyRecord, settings: Settings) {
  const all = multiAssetSummary(trades, settings, { instrument: 'all', start: day.date, end: day.date });
  const breakdown = [...all.byInstrument].sort((a,b)=>INSTRUMENTS.indexOf(a.key as typeof INSTRUMENTS[number])-INSTRUMENTS.indexOf(b.key as typeof INSTRUMENTS[number])).map(group => `${INSTRUMENT_LABELS[group.key as keyof typeof INSTRUMENT_LABELS]}：${group.currencyBuckets.length ? group.currencyBuckets.map(bucket => `${moneyFormat(bucket.netPnl, 2)} ${bucket.currency}`).join('、') : '暂无已实现现金流'}`).join('；');
  const actual = derivedDaily(trades, day.date, settings);
  const evidence = actual.executionDiscipline.evidence.map(item => item.reason);
  return `全品种新开仓${all.newTrades}笔，完整平仓${all.closedCount}笔。黄金原账户：${dailySummaryDraft(legacyGold(trades), day, settings)}分品种当日已实现净损益（原币种分别列示）：${breakdown || '暂无交易现金流'}。${evidence.length ? '全品种已保存纪律证据：' + evidence.join('；') + '。' : ''}`;
}
export function DailyAutoSummary({ trades, date, settings }: { trades: TradeRecord[]; date: string; settings: Settings }) {
  const a = derivedDaily(legacyGold(trades), date, settings), global = derivedDaily(trades, date, settings);
  const all = multiAssetSummary(trades, settings, { instrument: 'all', start: date, end: date });
  const tradeById = new Map(trades.map(trade => [trade.id, trade]));
  const holdings = global.currentPositions.holdings.map(position => ({ ...position, trade: tradeById.get(position.tradeId)! }));
  const reported = trades.filter(trade => !trade.archived && (trade.openedDate === date || trade.entries?.some(entry => entry.date === date) || trade.closes.some(close => close.date === date)));
  const issues = reported.filter(trade => trade.riskCompliant === false || !trade.inPlan || trade.psychology?.discipline === 'violated');
  return <section className="daily-auto-summary"><strong>多品种正式交易 · 新开仓 {all.newTrades} 笔</strong><div className="calculation-grid">{all.byInstrument.map(group => <div key={group.key}><span>{INSTRUMENT_LABELS[group.key as keyof typeof INSTRUMENT_LABELS]} · {group.tradeCount} 笔 / 完整平仓 {group.closedCount} 笔</span><strong>{group.currencyBuckets.length ? group.currencyBuckets.map(bucket => `${moneyFormat(bucket.netPnl, 2)} ${bucket.currency}`).join(' / ') : '暂无已实现现金流'}</strong><small>完整父交易净R {amount(group.totalR)}</small></div>)}</div><p className="muted-note">按品种及原结算币种分别列示当日已实现净损益；不同合约数量逐笔查看。综合金额{all.conversionComplete ? `为 ${moneyFormat(all.netPnl!, 2)} ${all.currency}，只使用已确认且有来源的当日汇率` : '因缺少可靠的当日汇率暂不汇总'}；不同账户收益率与回撤不合并。</p><details><summary>黄金原账户 · 原有自动统计</summary><div className="calculation-grid">{[
    ['开仓 / 加仓成交', `${a.entryEventCount} / ${a.addEntryEventCount}`], ['部分平仓事件', a.partialCloseEventCount], ['完整平仓父交易', a.completedParentTradeCount],
    ['当日已实现净损益', amount(a.realizedNetPnl) + ' ' + a.currency], ['实际手续费', amount(a.fees.actualKnownSum)], ['估算手续费', amount(a.fees.estimatedKnownSum)],
    ['来源未标手续费', amount(a.fees.unspecifiedKnownSum)], ['当前持仓笔数', a.currentPositions.parentTradeCount], ['剩余数量', '按交易分别列示'],
    ['完整父交易净R', amount(a.completedNetR)],
  ].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{value}</strong></div>)}</div><p className="muted-note">仅黄金原账户（XAU / legacy），金额限 {a.currency}；费用覆盖 {a.fees.knownEventCount}/{a.fees.eventCount}，R覆盖 {a.knownRParentCount}/{a.completedParentTradeCount}。部分平仓不增加完整样本；当前持仓为最新保存状态，{date} 日末持仓 {a.endOfDayPositions.parentTradeCount} 笔。费用已包含于保存净损益，不重复扣除。</p></details>{holdings.length > 0 && <details><summary>全品种当前持仓 · 逐笔数量</summary><div className="calculation-grid">{holdings.map(({ tradeId, remainingQuantity, trade }) => <div key={tradeId}><span>{INSTRUMENT_LABELS[instrumentOf(trade)]} · {trade.symbol || '合约未记录'} · {accountOf(trade)}</span><strong>{remainingQuantity === null ? '数量未知' : moneyFormat(remainingQuantity, 4)} · {assetTradeCurrency(trade, settings)}</strong></div>)}</div></details>}{global.executionDiscipline.evidence.length > 0 && <p className="warning-note">全品种交易事件保存了违规证据：{global.executionDiscipline.evidence.map(item=>item.reason).join("；")}。统计纪律评价会结合这些证据，完全守纪的自评不能覆盖已知违规；原始自评和历史成交仍保留。</p>}{issues.length > 0 && <p className="warning-note">相关交易中有 {issues.length} 笔保存了计划外或违规标记。仅展示原记录，不用当前规则追溯重判；不重复计入每日手工次数。</p>}</section>;
}
export function QuickCheckin({ day, change, text, commit, read, trades, settings }: { day: DailyRecord; change: (p: Partial<DailyRecord>) => void; text: (v: string) => void; commit: () => void; read: () => DailyRecord; trades: TradeRecord[]; settings: Settings }) {
  const q = day.quick ?? blankQuick();
  const set = (p: Partial<typeof q>, extra: Partial<DailyRecord> = {}) => change({ ...extra, quick: { ...(read().quick ?? q), ...p } });
  const toggle = (key: 'structures' | 'emotions', value: string) => { const values = (read().quick ?? q)[key]; set({ [key]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] }, key === 'emotions' && value === '想回本' ? { wellbeing: { ...read().wellbeing, recoveryUrgency: !values.includes(value) } } : {}); };
  const note = (value: string) => { text(value); commit(); };
  const draft = scopedDailySummaryDraft(trades, day, settings), actual = derivedDaily(trades, day.date, settings);
  return <section className="quick-checkin">
    <Picks label="当天市场自评" options={markets} value={q.market} onChange={value => set({ market: value as typeof q.market }, { environment: value === 'up' ? '明确上涨' : value === 'down' ? '明确下跌' : value === 'range' ? '窄幅震荡' : '无趋势', marketState: value === 'up' || value === 'down' ? 'trend' : value === 'range' ? 'range' : value === 'transition' ? 'transition' : null })}/>
    <Picks label="主要结构观察" options={structures.map(value => [value, value])} value={q.structures} multi onChange={value => toggle('structures', value)}/>
    <Picks label="今日机会" options={[["A", "A类机会"], ["normal", "普通机会"], ["none", "无合适机会"], ["unknown", "不确定"]]} value={q.opportunity} onChange={value => set({ opportunity: value as typeof q.opportunity }, { aOpportunity: value === 'A' })}/>
    <Picks label="当天纪律自评" options={[["full", "完全按计划"], ["partial", "部分偏离"], ["broken", "明显违规"], ["noTrade", "无新增交易"], ["unrated", "尚未评价"]]} value={q.discipline} onChange={value => set({ discipline: value as typeof q.discipline, noTrade: value === 'noTrade' }, { disciplineAssessed: value !== 'unrated', planCompliant: value === 'full' || value === 'noTrade' })}/>
    {q.noTrade && actual.newParentTradeCount > 0 && <p className="warning-note">正式记录有 {actual.newParentTradeCount} 笔新增交易，请核对“无新增交易”自评；已有成交和收益不会被删除。</p>}
    <Picks label="主要情绪" options={emotions.map(value => [value, value])} value={q.emotions} multi onChange={value => toggle('emotions', value)}/>
    <Picks label="主观精力 · 1—10分，选填" options={[["", "未填写"], ...Array.from({ length: 10 }, (_, index) => [String(index + 1), String(index + 1)] as const)]} value={day.wellbeing?.energy == null ? '' : String(day.wellbeing.energy)} onChange={value => change({ wellbeing: { ...read().wellbeing, energy: value === '' ? undefined : Number(value) } })}/>
    <label className="form-field range-field"><span className="field-label">FOMO / 踏空焦虑 · {day.fomoRecorded === false ? '未填写' : day.fomo + '/10'}</span><input type="range" min={0} max={10} value={day.fomo} onChange={event => change({ fomo: Number(event.target.value), fomoRecorded: true })}/><button type="button" className="icon-text" onClick={() => change({ fomo: 0, fomoRecorded: false })}>设为未填写</button></label>
    <details className="phrase-templates"><summary>当天最大的执行问题 · 选填</summary><Picks label="问题标签" options={['提前入场', '方向冲突', '风险超限', '无计划加仓', '止损扩大', '过早止盈', '止损后立即重进', '频次超限', '非交易时间开仓', '其他'].map(value => [value, value])} value={q.structures.filter(value => value.startsWith('执行:')).map(value => value.slice(3))} multi onChange={value => toggle('structures', '执行:' + value)}/></details>
    <BufferedText key={day.date + 'quick-note'} label="一句话复盘 · 可留空" value={day.note} rows={2} maxLength={5000} onDraft={text} onCommit={commit}/>
    <details className="phrase-templates"><summary>根据正式交易生成小结草稿</summary><p>{draft}</p><button type="button" className="button secondary" onClick={() => note(draft)}>使用这份草稿 · 可继续编辑</button><p className="muted-note">交易数字来自正式记录，市场与纪律仅使用当前已选自评；未填项保持未知，不根据盈亏判断守规。</p></details>
    <details className="phrase-templates"><summary>常用短语 · 点击后加入复盘</summary><div className="quick-picks">{phrases.map(value => <button type="button" key={value} onClick={() => note((read().note ? read().note + '；' : '') + value)}>{value}</button>)}</div></details>
  </section>;
}
