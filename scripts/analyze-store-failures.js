// 用法：node scripts/analyze-store-failures.js [输入CSV] [输出目录]
// store_channel 是渠道/类型，不是门店ID；仅统计 play_status=0。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseCsv, toCsv } = require('./extract-failed-events');

function main() {
  const input = path.resolve(process.argv[2] || path.join(__dirname, '../docs/media_events.csv'));
  const output = path.resolve(process.argv[3] || path.join(__dirname, '../docs/failure-analysis'));
  const [headers, ...rows] = parseCsv(fs.readFileSync(input, 'utf8'));
  if (!headers || new Set(headers).size !== headers.length) throw new Error('CSV为空或列名重复');
  for (const key of ['event_id', 'event_time', 'store_channel', 'play_status']) {
    if (!headers.includes(key)) throw new Error(`缺少列：${key}`);
  }
  const events = new Map();
  let duplicates = 0;
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) throw new Error(`第${index + 2}条记录列数不一致`);
    const event = Object.fromEntries(headers.map((key, i) => [key, row[i]]));
    if (!event.event_id.trim()) throw new Error(`第${index + 2}条记录缺少事件ID`);
    const previous = events.get(event.event_id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(event)) throw new Error(`重复ID内容冲突：${event.event_id}`);
      duplicates++;
      continue;
    }
    if (!Number.isFinite(Date.parse(event.event_time))) throw new Error(`时间无效：${event.event_id}`);
    events.set(event.event_id, event);
  }
  const groups = new Map();
  for (const event of events.values()) {
    const channel = event.store_channel || '(空)';
    if (!groups.has(channel)) groups.set(channel, []);
    if (event.play_status.trim() === '0') groups.get(channel).push(event);
  }
  const summary = [...groups].map(([store_channel, failures]) => {
    failures.sort((a, b) => Date.parse(a.event_time) - Date.parse(b.event_time));
    return { store_channel, failure_count: failures.length, failures };
  }).sort((a, b) => b.failure_count - a.failure_count);
  const summaryPath = path.join(output, 'store_failure_counts.csv');
  const detailPath = path.join(output, 'store_failure_times.csv');
  const timeReports = [
    ['hourly_failure_stats.csv', ['hour_beijing'], e => [beijingTime(e).slice(11, 13)]],
    ['store_hourly_failure_stats.csv', ['store_channel', 'hour_beijing'], e => [e.store_channel || '(空)', beijingTime(e).slice(11, 13)]],
    ['date_hour_failure_stats.csv', ['date_beijing', 'hour_beijing'], e => [beijingTime(e).slice(0, 10), beijingTime(e).slice(11, 13)]],
  ];
  // 固定 UTC+8，避免依赖运行电脑所在时区。
  function beijingTime(e) { return new Date(Date.parse(e.event_time) + 8 * 3600000).toISOString(); }
  function timeStats(keyOf) {
    const bins = new Map();
    for (const e of events.values()) {
      const keys = keyOf(e), key = JSON.stringify(keys);
      if (!bins.has(key)) bins.set(key, { keys, total: 0, failed: 0, success: 0, unknown: 0, invalid: 0, tasks: [] });
      const b = bins.get(key), status = e.play_status.trim();
      b.total++;
      b[status === '0' ? 'failed' : status === '1' ? 'success' : status === '' ? 'unknown' : 'invalid']++;
      if (e.concurrent_tasks?.trim() && Number.isFinite(Number(e.concurrent_tasks))) b.tasks.push(Number(e.concurrent_tasks));
    }
    return [...bins.values()].sort((a, b) => JSON.stringify(a.keys).localeCompare(JSON.stringify(b.keys))).map(b => [
      ...b.keys, b.total, b.failed, b.success, b.unknown, b.invalid,
      b.failed + b.success ? (100 * b.failed / (b.failed + b.success)).toFixed(2) : '',
      b.tasks.length ? (b.tasks.reduce((a, v) => a + v, 0) / b.tasks.length).toFixed(2) : '',
    ]);
  }
  if ([summaryPath, detailPath, ...timeReports.map(([file]) => path.join(output, file))].some(p => p.toLowerCase() === input.toLowerCase())) throw new Error('输出不能覆盖输入');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(summaryPath, toCsv([
    ['store_channel', 'failure_count', 'first_failure_time', 'last_failure_time'],
    ...summary.map(g => [g.store_channel, g.failure_count, g.failures[0]?.event_time, g.failures.at(-1)?.event_time]),
  ]));
  fs.writeFileSync(detailPath, toCsv([
    ['store_channel', 'event_id', 'event_time'],
    ...summary.flatMap(g => g.failures.map(e => [g.store_channel, e.event_id, e.event_time])),
  ]));
  for (const [file, keys, keyOf] of timeReports) {
    const stats = timeStats(keyOf);
    fs.writeFileSync(path.join(output, file), toCsv([
      [...keys, 'total_events', 'failed', 'success', 'unknown', 'invalid_status', 'failure_rate_percent', 'mean_concurrent_tasks'], ...stats,
    ]));
    if (keys.length === 1) console.table(stats.map(r => ({ hour: r[0], total: r[1], failed: r[2], success: r[3], unknown: r[4], failure_rate_percent: r[6], mean_concurrent_tasks: r[7] })));
  }
  console.table(summary.map(({ store_channel, failure_count }) => ({ store_channel, failure_count })));
  console.log(`原始${rows.length}条；去除完全相同的重复记录${duplicates}条；唯一事件${events.size}条；失败${summary.reduce((n, g) => n + g.failure_count, 0)}次。`);
  console.log('按渠道统计；空状态不计失败；时间保留原始时区，按实际时间排序。');
  console.log(`次数汇总：${summaryPath}\n失败时间明细：${detailPath}`);
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
