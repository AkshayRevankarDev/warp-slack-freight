import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuoteText, ParseError, nextBusinessDayISO } from '../src/parse.js';

test('parses canonical form', () => {
  const p = parseQuoteText('90001 to 60601, 2 pallets, 1000 lbs');
  assert.equal(p.originZip, '90001');
  assert.equal(p.destZip, '60601');
  assert.equal(p.pallets, 2);
  assert.equal(p.weightLbs, 1000);
  assert.match(p.pickupDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.payload.listItems[0].weight.value, 1000);
});

test('accepts loose punctuation and arrow', () => {
  const p = parseQuoteText('from 90001 -> 60601 1 pallet 500lb');
  assert.equal(p.originZip, '90001');
  assert.equal(p.destZip, '60601');
  assert.equal(p.pallets, 1);
  assert.equal(p.weightLbs, 500);
});

test('defaults pallets to 1 if not stated', () => {
  const p = parseQuoteText('90001 60601 1200 lbs');
  assert.equal(p.pallets, 1);
});

test('respects an explicit pickup date', () => {
  const p = parseQuoteText('90001 to 60601 1000 lbs pickup 2026-08-15');
  assert.equal(p.pickupDate, '2026-08-15');
});

test('rejects missing weight', () => {
  assert.throws(() => parseQuoteText('90001 to 60601 2 pallets'), (e) => e instanceof ParseError);
});

test('rejects only one zip', () => {
  assert.throws(() => parseQuoteText('60601 1000 lbs'), (e) => e instanceof ParseError);
});

test('rejects empty text', () => {
  assert.throws(() => parseQuoteText(''), (e) => e instanceof ParseError);
});

test('nextBusinessDayISO skips weekends', () => {
  // Friday 2026-07-31 → Monday 2026-08-03
  const out = nextBusinessDayISO(new Date('2026-07-31T12:00:00Z'));
  assert.equal(out, '2026-08-03');
});
