import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, normalizeTransit, formatUSD, quoteBlocks } from '../src/slack/blocks.js';

test('normalizeTransit converts seconds to days', () => {
  assert.deepEqual(normalizeTransit(432000), { days: 5, label: '5 days' });
  assert.deepEqual(normalizeTransit(345600), { days: 4, label: '4 days' });
});

test('normalizeTransit treats 0 as unknown', () => {
  assert.deepEqual(normalizeTransit(0), { days: null, label: '—' });
});

test('normalizeTransit leaves already-days values alone', () => {
  // single-quote endpoint returns e.g. 5 (days), not 432000 (seconds)
  assert.deepEqual(normalizeTransit(5), { days: 5, label: '5 days' });
});

test('normalizeOptions sorts cheapest-first and rounds prices', () => {
  const raw = [
    { id: 'a', carrierName: 'A', rate: 760.572527, transitTime: 432000, serviceLevel: 'STANDARD' },
    { id: 'b', carrierName: 'B', rate: 432.288, transitTime: 259200, serviceLevel: 'STANDARD' },
    { id: 'c', carrierName: 'C', rate: 589.86, transitTime: 345600 }, // no serviceLevel
  ];
  const out = normalizeOptions(raw);
  assert.equal(out[0].id, 'b');
  assert.equal(out[0].rate, 432.29);
  assert.equal(out[1].id, 'c');
  assert.equal(out[1].serviceLevel, null);
  assert.equal(out[2].id, 'a');
});

test('normalizeOptions puts rate-less entries at the bottom', () => {
  const out = normalizeOptions([
    { id: 'x', carrierName: 'X' }, // no rate
    { id: 'y', carrierName: 'Y', rate: 100 },
  ]);
  assert.equal(out[0].id, 'y');
  assert.equal(out[1].id, 'x');
});

test('formatUSD renders currency and handles missing', () => {
  assert.equal(formatUSD(432.288), '$432.29');
  assert.equal(formatUSD(null), '—');
});

test('quoteBlocks renders an empty-lane message when there are no options', () => {
  const lane = { originZip: '90001', destZip: '00500', pallets: 1, weightLbs: 500, pickupDate: '2026-07-30' };
  const blocks = quoteBlocks({ lane, options: [], latencyMs: 1234 });
  const text = JSON.stringify(blocks);
  assert.match(text, /No rates available/);
});

test('quoteBlocks headlines the cheapest option', () => {
  const lane = { originZip: '90001', destZip: '60601', pallets: 2, weightLbs: 1000, pickupDate: '2026-07-30' };
  const options = normalizeOptions([
    { id: 'a', carrierName: 'Forward Air', rate: 432.29, transitTime: 259200, serviceLevel: 'STANDARD' },
    { id: 'b', carrierName: 'XPO', rate: 755.12, transitTime: 432000, serviceLevel: 'STANDARD' },
  ]);
  const blocks = quoteBlocks({ lane, options, latencyMs: 5000 });
  const text = JSON.stringify(blocks);
  assert.match(text, /Cheapest/);
  assert.match(text, /Forward Air/);
  assert.match(text, /\$432\.29/);
});
