// 使用：node scripts/extract-failed-events.js [输入CSV] [输出目录]
// 无第三方依赖；默认读取 docs/media_events.csv，输出到 docs/failure-analysis。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 支持 BOM、CRLF、带引号的逗号/换行和双引号转义。
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (row.some(value => value !== '')) rows.push(row);
        row = [];
      }
    } else if (c === '"' && field === '' && !closed) {
      quoted = true;
    } else {
      if (closed || c === '"') throw new Error('CSV 引号格式错误');
      field += c;
    }
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  if (field !== '' || row.length || closed) { row.push(field); rows.push(row); }
  return rows;
}

function toCsv(rows) {
  return '\uFEFF' + rows.map(row => row.map(value => {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n') + '\r\n';
}

function describe(values) {
  const valid = values.filter(v => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) return { valid_count: 0, missing_or_invalid_count: values.length };
  const n = valid.length;
  return {
    valid_count: n, missing_or_invalid_count: values.length - n,
    min: valid[0], max: valid[n - 1],
    mean: valid.reduce((a, b) => a + b, 0) / n,
    median: (valid[Math.floor((n - 1) / 2)] + valid[Math.floor(n / 2)]) / 2,
  };
}

function main() {
  const input = path.resolve(process.argv[2] || path.join(__dirname, '../docs/media_events.csv'));
  const output = path.resolve(process.argv[3] || path.join(__dirname, '../docs/failure-analysis'));
  const rows = parseCsv(fs.readFileSync(input, 'utf8'));
  if (!rows.length) throw new Error('CSV 为空');
  const headers = rows.shift();
  const required = ['event_id', 'event_time', 'config_synced_at', 'store_channel', 'media_category', 'cache_remain_mb', 'concurrent_tasks', 'play_status'];
  if (new Set(headers).size !== headers.length) throw new Error('CSV 存在重复列名');
  for (const key of required) if (!headers.includes(key)) throw new Error(`缺少列：${key}`);
  const records = rows.map((row, i) => {
    if (row.length !== headers.length) throw new Error(`第 ${i + 2} 条 CSV 记录列数不一致`);
    return Object.fromEntries(headers.map((h, j) => [h, row[j]]));
  });
  const status = r => r.play_status.trim();
  const failed = records.filter(r => status(r) === '0');
  const successCount = records.filter(r => status(r) === '1').length;
  const unknownCount = records.filter(r => status(r) === '').length;
  const invalidCount = records.length - failed.length - successCount - unknownCount;
  const number = v => v.trim() === '' ? null : Number(v);
  const ageMinutes = r => {
    const age = (Date.parse(r.event_time) - Date.parse(r.config_synced_at)) / 60000;
    return Number.isFinite(age) ? age : null;
  };
  const groupBy = key => {
    const groups = new Map();
    for (const r of records) {
      const value = r[key] || '(空)';
      if (!groups.has(value)) groups.set(value, { value, total: 0, failed: 0, success: 0, unknown: 0, invalid_status: 0 });
      const g = groups.get(value);
      g.total++;
      g[status(r) === '0' ? 'failed' : status(r) === '1' ? 'success' : status(r) === '' ? 'unknown' : 'invalid_status']++;
    }
    return [...groups.values()].map(g => ({ ...g,
      failure_rate: g.failed + g.success ? g.failed / (g.failed + g.success) : null,
      share_of_all_failures: failed.length ? g.failed / failed.length : null,
    })).sort((a, b) => b.failed - a.failed);
  };
  const summary = {
    source: input,
    definitions: {
      failure: 'play_status 去除首尾空白后严格等于 0；空值不视为失败',
      failure_rate: '失败数 / (成功数 + 失败数)，0~1；分母为0时为null',
      config_age_minutes: '按时间戳时区计算 event_time - config_synced_at，单位分钟；负值保留并报告',
      duplicates: '保留原始事件记录，不自动去重；重复ID数量另行报告',
    },
    total_events: records.length, failed_events: failed.length,
    successful_events: successCount, unknown_events: unknownCount, invalid_status_events: invalidCount,
    duplicate_event_id_count: records.length - new Set(records.map(r => r.event_id)).size,
    failure_rate: failed.length + successCount ? failed.length / (failed.length + successCount) : null,
    estimated_failure_loss_minutes: failed.length * 90,
    failed_event_metrics: {
      cache_remain_mb: describe(failed.map(r => number(r.cache_remain_mb))),
      concurrent_tasks: describe(failed.map(r => number(r.concurrent_tasks))),
      config_age_minutes: describe(failed.map(ageMinutes)),
      negative_config_age_count: failed.filter(r => ageMinutes(r) !== null && ageMinutes(r) < 0).length,
    },
    by_store_channel: groupBy('store_channel'),
    by_media_category: groupBy('media_category'),
  };
  const csvPath = path.join(output, 'failed_events.csv');
  const jsonPath = path.join(output, 'failure_summary.json');
  if ([csvPath, jsonPath].some(p => p.toLowerCase() === input.toLowerCase())) throw new Error('输出路径不能覆盖输入文件');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(csvPath, toCsv([
    [...headers, 'config_age_minutes'],
    ...failed.map(r => [...headers.map(h => r[h]), ageMinutes(r)]),
  ]), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`总记录：${records.length}；失败：${failed.length}；成功：${successCount}；未回传：${unknownCount}；非法状态：${invalidCount}`);
  console.log(`已回传失败率：${summary.failure_rate === null ? '无' : (summary.failure_rate * 100).toFixed(2) + '%'}`);
  console.log(`失败明细：${csvPath}\n基础汇总：${jsonPath}`);
}

module.exports = { parseCsv, toCsv };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`提取失败：${error.message}`); process.exitCode = 1; }
}
