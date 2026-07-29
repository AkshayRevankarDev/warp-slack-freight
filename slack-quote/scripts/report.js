// Quick summary of the quote log. Answers "how many quotes this week, on which lanes"
// per the brief. Run: `npm run report [--since=2026-07-01]`.

import { QuoteLog } from '../src/log.js';
import { config } from '../src/config.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const log = new QuoteLog(config.quoteLogPath);
const rows = log.readAll();
const since = args.since ? new Date(args.since) : new Date(Date.now() - 7 * 86400_000);
// Restrict to quote events — the brief's question is "how many quotes this week".
// (`--all` widens to include track/shipments/details.)
const recent = rows
  .filter((r) => new Date(r.ts) >= since)
  .filter((r) => args.all ? true : r.kind === 'quote');

if (!recent.length) {
  console.log(`No quotes logged since ${since.toISOString()}.`);
  process.exit(0);
}

const byOutcome = tally(recent, (r) => r.outcome || 'ok');
const byLane = tally(recent, (r) => r.lane ? `${r.lane.originZip}→${r.lane.destZip}` : 'unknown');
const byUser = tally(recent, (r) => r.slack?.user || 'unknown');
const latencies = recent.map((r) => r.latencyMs).filter((n) => typeof n === 'number');
const p50 = pct(latencies, 0.5);
const p95 = pct(latencies, 0.95);

console.log(`Quotes since ${since.toISOString().slice(0, 10)}: ${recent.length}`);
console.log('\nOutcome:');
for (const [k, v] of top(byOutcome)) console.log(`  ${k.padEnd(12)} ${v}`);
console.log('\nTop lanes:');
for (const [k, v] of top(byLane).slice(0, 10)) console.log(`  ${k.padEnd(14)} ${v}`);
console.log('\nTop users:');
for (const [k, v] of top(byUser).slice(0, 5)) console.log(`  ${k.padEnd(20)} ${v}`);
if (latencies.length) console.log(`\nLatency  p50=${(p50 / 1000).toFixed(1)}s  p95=${(p95 / 1000).toFixed(1)}s`);

function tally(rows, key) {
  const m = new Map();
  for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + 1);
  return m;
}
function top(m) {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
