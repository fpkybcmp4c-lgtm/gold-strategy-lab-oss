import { addDays, assessedDiscipline, discipline, equitySeries, MODELS, periodKey, pnl, riskR, summarize } from './domain.ts';
import type { DailyRecord, Settings } from './domain.ts';

export const STATE_THRESHOLDS = { highStress: 8, lowEnergy: 3, shortSleep: 5, highFomo: 7 };
const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const known = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const band = (v: number) => v <= 3 ? 0 : v <= 6 ? 1 : 2;

export function readiness(day: DailyRecord) {
  const w = day.wellbeing;
  const ratings = [w?.stress, w?.worry, w?.energy];
  const complete = ratings.every(known);
  const pause = (known(w?.stress) && w.stress >= 8) || (known(w?.worry) && w.worry >= 8)
    || (known(w?.energy) && w.energy <= 3) || (known(w?.sleepHours) && w.sleepHours < 5);
  const cautious = (known(w?.stress) && w.stress >= 4) || (known(w?.worry) && w.worry >= 4)
    || (known(w?.energy) && w.energy <= 6) || (known(w?.sleepHours) && w.sleepHours < 6)
    || day.fomo>=STATE_THRESHOLDS.highFomo || day.impulses>0 || !!w?.recoveryUrgency || !!w?.impulsiveReversal;
  const status = pause ? 'pause' : cautious ? 'cautious' : complete ? 'good' : 'unknown';
  const warnings: string[] = [];
  if (w?.recoveryUrgency) warnings.push('急于回本：先离开下单界面，等待情绪缓和，再核对既定计划。');
  if (day.fomo >= STATE_THRESHOLDS.highFomo) warnings.push('踏空焦虑偏高：不要追价或放宽信号，只有原计划允许的机会才考虑。');
  if (w?.impulsiveReversal) warnings.push('有冲动反手念头：暂停新的自主决策，避免用下一笔交易抵消上一笔情绪。');
  if (day.impulses > 0) warnings.push('今天已发生冲动交易：先完成复盘，再评估是否适合继续新增交易。');
  const messages = {
    pause: ['建议暂停新增自主交易', '情绪负担很高或疲劳明显。已有仓位按既定风险管理计划处理，恢复后再评估状态。'],
    cautious: ['仅考虑计划内的高质量机会', '状态或风险信号提示需要谨慎。减少主动盯盘与临时决策，先核对入场条件。'],
    good: ['按既定策略正常执行', '已填写的压力、担忧与精力状态良好，继续遵守已有交易计划和风险上限。'],
    unknown: ['状态信息尚不完整', '填写压力、担忧与精力后可得到状态参考；未填写不等于状态良好。'],
  };
  return { status, title: messages[status][0], body: messages[status][1], warnings, partial: !complete };
}

export function growthSummary(allRecords: DailyRecord[], end: string, window: 14 | 30, settings: Settings) {
  const start = addDays(end, 1 - window);
  const records = allRecords.filter(d => d.hasDailyState!==false && d.date >= start && d.date <= end).sort((a,b) => a.date.localeCompare(b.date));
  const map = new Map(records.map(d => [d.date, d]));
  const trend = Array.from({ length: window }, (_, i) => {
    const date = addDays(start, i), day = map.get(date), w = day?.wellbeing;
    return { date, label: date.slice(5), stress: w?.stress ?? null, worry: w?.worry ?? null,
      energy: w?.energy ?? null, sleepHours: w?.sleepHours ?? null };
  });
  const stressRecords = records.filter(d => known(d.wellbeing?.stress));
  const energyRecords = records.filter(d => known(d.wellbeing?.energy));
  const stress = ['低压力 0–3', '中压力 4–6', '高压力 7–10'].map((label, i) => {
    const days = stressRecords.filter(d => band(d.wellbeing!.stress!) === i);
    return { label, days: days.length, violations: days.reduce((s,d) => s+d.violations,0), averageViolations: average(days.map(d => d.violations)) };
  });
  const energy = ['低精力 0–3', '中精力 4–6', '高精力 7–10'].map((label, i) => {
    const days = energyRecords.filter(d => d.disciplineAssessed!==false && band(d.wellbeing!.energy!) === i);
    return { label, days: days.length, compliantDays: days.filter(d => d.planCompliant).length,
      complianceRate: days.length ? 100 * days.filter(d => d.planCompliant).length / days.length : null,
      discipline: average(days.map(d => discipline(d, settings.riskLimit))) };
  });
  const traded = records.filter(d => d.fomoRecorded!==false && d.trades.some(t=>!t.partial));
  const fomo = ['低 FOMO 0–3', '中 FOMO 4–6', '高 FOMO 7–10'].map((label, i) => {
    const days = traded.filter(d => band(d.fomo) === i), trades = days.flatMap(d => d.trades).filter(t=>!t.partial);
    const outcome=(t:typeof trades[number])=>t.tradeNetPnl??t.netPnl;
    return { label, days: days.length, trades: trades.length, profit: trades.reduce((s,t) => s+Math.max(0,outcome(t)),0),
      loss: trades.reduce((s,t) => s+Math.max(0,-outcome(t)),0), netPnl: trades.reduce((s,t)=>s+outcome(t),0),
      wins: trades.filter(t => outcome(t) > 0).length, losses: trades.filter(t => outcome(t) < 0).length,
      flat: trades.filter(t => outcome(t) === 0).length, averagePnl: average(trades.map(outcome)) };
  });
  const stressValues = stressRecords.map(d => d.wellbeing!.stress!), energyValues = energyRecords.map(d => d.wellbeing!.energy!);
  const sleepValues = records.map(d => d.wellbeing?.sleepHours).filter(known);
  return { start, end, records, trend, stress, energy, fomo, stressCount: stressValues.length,
    energyCount: energyValues.length, sleepCount: sleepValues.length, tradedDays: traded.length,
    meanStress: average(stressValues), meanEnergy: average(energyValues), meanSleep: average(sleepValues) };
}

export function fatigueSummary(records: DailyRecord[]) {
  records=records.filter(d=>d.hasDailyState!==false);
  const total = records.reduce((s,d) => s+d.violations,0);
  const events = records.flatMap(d => (d.wellbeing?.violationContexts ?? []).slice(0,d.violations)
    .filter(c => c.time !== null && c.fatigued !== null).map(c => ({ date:d.date, time:c.time!, fatigued:c.fatigued! })));
  const tired = events.filter(c => c.fatigued).length;
  const periods = [ ['凌晨', 0, 6], ['上午', 6, 12], ['下午', 12, 18], ['晚间', 18, 24] ] as const;
  const timeBands = periods.map(([label, low, high]) => {
    const group = events.filter(e => Number(e.time.slice(0,2)) >= low && Number(e.time.slice(0,2)) < high);
    return { label, events:group.length, tired:group.filter(e => e.fatigued).length };
  });
  let text: string;
  if (total === 0) text = '本周没有填报违规，无法比较违规与疲劳的关系。';
  else if (events.length < total) text = `数据不足：${total} 次违规中，仅 ${events.length} 次同时记录了发生时间与当时疲劳状态；已知其中 ${tired} 次疲劳，无法判断全部违规是否集中。`;
  else text = `全部 ${total} 次违规都有时间与疲劳补充，其中 ${tired} 次自报疲劳（${(100*tired/total).toFixed(0)}%）。${tired>total/2?'本周多数发生在自报疲劳时':'本周没有出现多数发生在自报疲劳时的情况'}；这不证明疲劳导致违规。${total<5?'次数较少，仅描述本周分布，不能判断稳定规律。':''}`;
  return { total, known:events.length, tired, complete:total>0 && events.length===total, timeBands, text };
}

export function weeklyWellbeing(records: DailyRecord[]) {
  records=records.filter(d=>d.hasDailyState!==false);
  const stress = records.map(d => d.wellbeing?.stress).filter(known);
  const energy = records.map(d => d.wellbeing?.energy).filter(known);
  // Daily snapshots cannot establish intraday emotional volatility. Use a stated proxy only.
  const comparable = records.filter(d => known(d.wellbeing?.stress) && known(d.wellbeing?.worry));
  const peak = comparable.length >= 2 ? Math.max(...comparable.map(d => Math.max(d.wellbeing!.stress!,d.wellbeing!.worry!))) : null;
  const unstableDates = peak === null ? [] : comparable.filter(d => Math.max(d.wellbeing!.stress!,d.wellbeing!.worry!)===peak).map(d => d.date);
  const fatigue = fatigueSummary(records);
  const screen = records.length ? records.reduce((s,d) => s+d.screenMinutes,0)/records.length : null;
  let suggestion: string;
  if (fatigue.tired > 0) suggestion = '下周减少疲劳时的临时交易判断：出现低精力或明显疲劳时，暂停新增自主交易，按原计划管理已有仓位。';
  else if (screen !== null && screen > 60) suggestion = '下周减少无计划的长时间盯盘：只在既定信号检查窗口查看行情，其余时间离开下单界面。';
  else if (stress.some(v => v >= 7) || records.some(d => (d.wellbeing?.worry ?? -1) >= 7 || d.fomo >= 7 || d.wellbeing?.recoveryUrgency || d.wellbeing?.impulsiveReversal)) suggestion = '下周减少反复检查行情与盈亏：把临时想法记入复盘，等既定检查时间再核对计划。';
  else if (energy.some(v => v <= 3) || records.some(d => known(d.wellbeing?.sleepHours) && d.wellbeing!.sleepHours! < 5)) suggestion = '下周减少熬夜盯盘：给休息留出固定时段，疲劳明显时暂停新增自主交易。';
  else suggestion = '状态样本不足或未见明显消耗项。下周先尝试减少一次计划外的行情检查，继续记录精力变化后再判断。';
  return { meanStress:average(stress), stressCount:stress.length, meanEnergy:average(energy), energyCount:energy.length,
    unstableDates, unstableScore:peak, comparableDays:comparable.length, fatigue, suggestion };
}

export function weeklyReport(records: DailyRecord[], settings: Settings, reference: string, cutoff: string) {
  const monday = periodKey(reference, 'week'), sunday = addDays(monday,6);
  const start = monday > settings.start ? monday : settings.start;
  const end = [sunday, settings.end, cutoff].sort()[0];
  const points = equitySeries(records.filter(d => d.date <= end),settings).filter(d => d.date>=start && d.date<=end);
  return { start, end, monday, sunday, records:points, stats:summarize(points,settings,points), wellbeing:weeklyWellbeing(points) };
}

export function weeklyMarkdown(report: ReturnType<typeof weeklyReport>) {
  const { stats:s, wellbeing:w } = report;
  const n = (v:number|null, digits=1) => v===null ? '未记录 / 数据不足' : Number.isFinite(v) ? v.toFixed(digits) : '∞';
  const lines = ['# 黄金策略验证 + 个人状态｜周摘要', '', `覆盖区间：${report.start} 至 ${report.end}（北京时间）；正式记录 ${s.days} 天。`, '',
    '| 交易项目 | 结果 |', '| --- | --- |', `| 独立新开仓 / 完整平仓 / 部分平仓事件 | ${s.newTrades} 笔 / ${s.trades} 笔 / ${s.partialEvents} 次 |`,
    `| 扣费后净收益 | ${n(s.totalPnl,2)} USD |`, `| 已知 R 合计 / 平均 / 覆盖 | ${n(s.totalR,2)} / ${n(s.expectancy,2)} / ${s.knownR}/${s.trades} |`,
    `| 平均纪律 / 计划遵守率 | ${n(s.score)} 分 / ${n(s.complianceRate)}% |`, `| 违规 / 冲动 / 成功克制 | ${s.violations} / ${s.impulses} / ${s.resisted} 次 |`,
    `| 平均 FOMO / 主动盯盘 | ${n(s.fomo)} / 10；${s.days?n(s.screenMinutes/s.days):'未记录'} 分钟/记录日 |`, `| 平仓胜率 / 利润因子 | ${n(s.winRate)}% / ${n(s.profitFactor,2)} |`,
    `| 计划内 / 外净收益 | ${n(s.inPlanPnl,2)} / ${n(s.offPlanPnl,2)} USD |`, `| 已平仓账户最大回撤 | ${n(s.maxDrawdown,2)} USD；${n(s.maxDrawdownPct,2)}% |`, `| 填报日内最大回撤（独立） | ${n(s.maxReportedDD,2)} USD |`, '',
    '| 个人状态 | 结果 |', '| --- | --- |', `| 平均压力 | ${n(w.meanStress)} / 10；覆盖 ${w.stressCount}/${s.days} 天 |`,
    `| 平均精力 | ${n(w.meanEnergy)} / 10；覆盖 ${w.energyCount}/${s.days} 天 |`,
    `| 情绪负担最高日期（参考） | ${w.unstableDates.join('、') || '数据不足：至少两天同时填写压力与担忧'} |`, '',
    '情绪日期按压力与担忧的较高分比较，不测量日内情绪波动；并列日期全部列出。', '', w.fatigue.text, '',
    `已知疲劳违规的时段：${w.fatigue.timeBands.map(b=>`${b.label} ${b.tired}/${b.events} 次`).join('；')}（分子为自报疲劳次数，分母为该时段资料完整的违规）。`, '',
    `下周减少一项精力消耗：${w.suggestion}`, '', '| 日期 | 净收益 USD | 违规 | 遵守计划 | FOMO | 压力 | 担忧 | 精力 | 睡眠小时 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const d of report.records.filter(d=>d.hasDailyState!==false)) lines.push(`| ${d.date} | ${n(pnl(d),2)} | ${d.violations} | ${d.disciplineAssessed===false?'未评价':d.planCompliant?'是':'否'} | ${d.fomo} | ${n(d.wellbeing?.stress??null)} | ${n(d.wellbeing?.worry??null)} | ${n(d.wellbeing?.energy??null)} | ${n(d.wellbeing?.sleepHours??null)} |`);
  lines.push('', '| 模型 | 平仓笔数 | 计划内 / 外净收益 USD | 平均 R | R覆盖 |', '| --- | --- | --- | --- | --- |');
  // Reuse the per-trade R calculation. Daily discipline fields do not affect these model totals.
  for(const model of MODELS){
    const trades=report.records.flatMap(d=>d.trades).filter(t=>t.model===model);
    const completed=trades.filter(t=>!t.partial);
    const rs=completed.map(riskR).filter(known);
    lines.push(`| ${model} | ${completed.length} | ${n(trades.filter(t=>t.inPlan).reduce((a,t)=>a+t.netPnl,0),2)} / ${n(trades.filter(t=>!t.inPlan).reduce((a,t)=>a+t.netPnl,0),2)} | ${n(average(rs),2)} | ${rs.length}/${completed.length} |`);
  }
  lines.push('', '净收益按实际平仓日计入（已含费用，不重复扣费）；整笔R、胜率及利润因子只取完整平仓的整笔结果。旧汇总用稳定ID去重，未虚构平仓明细。旧日报自报开仓 / 持仓数只作参考，不与独立交易相加。仅使用已确认的正式记录；未填值不补零，草稿不参与统计。状态与交易的共同变化不证明因果，状态提示不会执行交易。');
  return lines.join('\n');
}
