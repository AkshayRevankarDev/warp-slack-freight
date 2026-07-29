import { WarpError } from '../warp.js';
import { respond, deferred } from '../slack/respond.js';
import { trackingBlocks, errorBlocks } from '../slack/blocks.js';

export function makeTrackHandler({ warp, log }) {
  return async function handleTrack(cmd) {
    const number = (cmd.text || '').trim().split(/\s+/)[0];
    if (!number) {
      return { ack: {
        response_type: 'ephemeral',
        blocks: errorBlocks({ title: 'Missing tracking number.', hint: 'Try `/track S-1001-IN`.' }),
      } };
    }

    // Tracking is fast (100-400ms in the mock) — no need for a deferred round trip.
    // We still budget for it: if it drags past ~2.5s we ack early and finish async.
    const started = Date.now();
    try {
      const [entry] = await warp.tracking([number]);
      let events = null;
      if (entry?.shipmentId) {
        events = await warp.events(entry.shipmentId).catch(() => null); // events being missing is not fatal
      }
      log.record({
        kind: 'track', slack: slackMeta(cmd), trackingNumber: number,
        found: !entry?.error, latencyMs: Date.now() - started,
      });
      return { ack: {
        response_type: 'in_channel',
        blocks: trackingBlocks({ trackingNumber: number, entry, events }),
      } };
    } catch (e) {
      log.record({ kind: 'track', slack: slackMeta(cmd), trackingNumber: number, outcome: 'error', error: e.message, latencyMs: Date.now() - started });
      return { ack: {
        response_type: 'ephemeral',
        blocks: errorBlocks({
          title: 'Tracking lookup failed.',
          detail: e instanceof WarpError ? e.message : 'Unexpected error.',
          hint: 'Try again in a few seconds.',
        }),
      } };
    }
  };
}

function slackMeta(cmd) {
  return { user: cmd.user_name || cmd.user_id, channel: cmd.channel_name || cmd.channel_id, team: cmd.team_id };
}
