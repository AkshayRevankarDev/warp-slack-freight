// /quote — the centerpiece. Slack drops us if we don't answer in 3s but rate-shop
// takes 4–16s, so we ack synchronously and deliver the real result via response_url.

import { parseQuoteText, ParseError } from '../parse.js';
import { WarpError } from '../warp.js';
import { respond, deferred } from '../slack/respond.js';
import { ackBlocks, quoteBlocks, errorBlocks, normalizeOptions } from '../slack/blocks.js';

export function makeQuoteHandler({ warp, log }) {
  return async function handleQuote(cmd) {
    // Parse first so we can reject bad input synchronously and skip the ack.
    let lane;
    try {
      lane = parseQuoteText(cmd.text);
    } catch (e) {
      if (e instanceof ParseError) {
        return { ack: {
          response_type: 'ephemeral',
          blocks: errorBlocks({ title: "Couldn't read that lane.", detail: e.message, hint: e.hint }),
        } };
      }
      throw e;
    }

    // Kick off the actual work — we intentionally don't await it here.
    fireAndReport(cmd, lane, { warp, log });

    return { ack: {
      response_type: 'ephemeral',
      blocks: ackBlocks({ lane }),
    } };
  };
}

async function fireAndReport(cmd, lane, { warp, log }) {
  const started = Date.now();
  let outcome = 'ok';
  let raw = null;
  let normalized = [];
  let errorMsg = null;

  try {
    raw = await warp.rateShop(lane.payload);
    normalized = normalizeOptions(raw.options);
    const blocks = quoteBlocks({
      lane, options: normalized, latencyMs: Date.now() - started,
    });
    await respond(cmd.response_url, deferred({ text: 'Rates', blocks, replace: true }));
  } catch (e) {
    outcome = e instanceof WarpError ? (e.code || `http_${e.status}`) : 'error';
    errorMsg = e.message;
    await respond(cmd.response_url, deferred({
      text: 'Quote failed',
      blocks: errorBlocks(quoteErrorBlock(e)),
      ephemeral: true,
      replace: true,
    })).catch(() => { /* swallow secondary failure so we still log the primary */ });
  } finally {
    log.record({
      kind: 'quote',
      slack: { user: cmd.user_name || cmd.user_id, channel: cmd.channel_name || cmd.channel_id, team: cmd.team_id },
      lane: { originZip: lane.originZip, destZip: lane.destZip, pallets: lane.pallets, weightLbs: lane.weightLbs, pickupDate: lane.pickupDate },
      outcome,
      error: errorMsg,
      latencyMs: Date.now() - started,
      results: normalized.slice(0, 5).map((o) => ({
        carrier: o.carrierName, rate: o.rate, transitDays: o.transit.days, serviceLevel: o.serviceLevel,
      })),
    });
  }
}

function quoteErrorBlock(e) {
  if (e instanceof WarpError) {
    if (e.status === 400) return { title: 'That request was rejected by the carrier system.', detail: e.message, hint: 'Check the lane and try again.' };
    if (e.status === 429 || e.status === 503) return { title: 'Carriers are throttling us right now.', detail: 'We retried and still hit a wall.', hint: 'Try again in a few seconds.' };
    if (e.status === 504) return { title: 'Rate-shop timed out.', detail: 'The upstream took too long to respond.', hint: 'Try again — it usually clears in 10s.' };
    if (e.status === 404) return { title: 'No rates on that lane.', detail: e.message };
    return { title: `Quote failed (${e.status || 'error'}).`, detail: e.message };
  }
  return { title: 'Something unexpected went wrong.', detail: e.message };
}
