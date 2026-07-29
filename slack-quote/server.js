// slack-quote — Warp Freight Desk for Slack.
//
// Two Slack surfaces:
//   POST /slack/commands      slash commands (/quote, /track, /shipments)
//   POST /slack/interactive   block-kit button clicks (shipments "Details")
//
// Both verify Slack's signature over the RAW body. The 3-second ack problem for
// /quote is solved by returning immediately and delivering the result to
// response_url when the slow rate-shop finishes (see src/handlers/quote.js).

import express from 'express';
import { config } from './src/config.js';
import { WarpClient } from './src/warp.js';
import { QuoteLog } from './src/log.js';
import { verifySlackRequest } from './src/slack/verify.js';
import { makeQuoteHandler } from './src/handlers/quote.js';
import { makeTrackHandler } from './src/handlers/track.js';
import { makeShipmentsHandler, makeShipmentDetailsHandler } from './src/handlers/shipments.js';
import { errorBlocks } from './src/slack/blocks.js';

const warp = new WarpClient({ baseUrl: config.warpBaseUrl, apiKey: config.warpApiKey });
const log = new QuoteLog(config.quoteLogPath);

const handleQuote = makeQuoteHandler({ warp, log });
const handleTrack = makeTrackHandler({ warp, log });
const handleShipments = makeShipmentsHandler({ warp, log });
const handleShipmentDetails = makeShipmentDetailsHandler({ warp, log });

const app = express();

// We need the RAW body byte-for-byte to verify Slack's HMAC signature. urlencoded
// parses reliably from a Buffer, so we capture the raw first then hand it over.
app.use('/slack', express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/slack/commands', async (req, res) => {
  if (!checkSignature(req, res)) return;
  const cmd = req.body; // { command, text, user_id, user_name, channel_id, channel_name, response_url, team_id, ... }

  try {
    const handler = routeCommand(cmd.command);
    if (!handler) {
      return res.json({ response_type: 'ephemeral', text: `Unknown command \`${cmd.command}\`.` });
    }
    const result = await handler(cmd);
    // ACK within 3s. Any longer work happens in the background via response_url.
    res.json(result.ack || { response_type: 'ephemeral', text: 'OK' });
  } catch (e) {
    console.error('command handler crashed', e);
    res.json({ response_type: 'ephemeral', blocks: errorBlocks({ title: 'Internal error.', detail: e.message }) });
  }
});

app.post('/slack/interactive', async (req, res) => {
  if (!checkSignature(req, res)) return;
  let payload;
  try { payload = JSON.parse(req.body.payload); }
  catch { return res.status(400).send('bad payload'); }

  // Always ack the button click immediately (empty 200 is the Slack idiom here).
  res.status(200).end();

  try {
    if (payload.type === 'block_actions') {
      for (const action of payload.actions || []) {
        if (action.action_id === 'shipment_details') {
          const { shipmentId, orderId } = JSON.parse(action.value);
          // Try to keep a friendly label for the response.
          const shipmentNumber = findShipmentNumber(payload, shipmentId);
          await handleShipmentDetails({
            shipmentId, orderId, shipmentNumber,
            responseUrl: payload.response_url,
            slack: { user: payload.user?.username || payload.user?.id, channel: payload.channel?.name || payload.channel?.id, team: payload.team?.id },
          });
        }
      }
    }
  } catch (e) {
    console.error('interactive handler crashed', e);
  }
});

// --- helpers --------------------------------------------------------------

function routeCommand(name) {
  switch (name) {
    case '/quote': return handleQuote;
    case '/track': return handleTrack;
    case '/shipments': return handleShipments;
    default: return null;
  }
}

function checkSignature(req, res) {
  if (config.skipSlackVerify) return true;
  const secret = config.slackSigningSecret;
  if (!secret) {
    res.status(500).json({ error: 'SLACK_SIGNING_SECRET is not configured on the server.' });
    return false;
  }
  const result = verifySlackRequest({
    signingSecret: secret,
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
    rawBody: req.rawBody || '',
  });
  if (!result.ok) {
    res.status(401).send(`slack signature check failed: ${result.reason}`);
    return false;
  }
  return true;
}

// The shipments-list message packed shipmentNumber into the section text; scrape it
// back out so the details reply can label itself nicely.
function findShipmentNumber(payload, shipmentId) {
  const blocks = payload.message?.blocks || [];
  for (const b of blocks) {
    if (b.accessory?.value?.includes(`"${shipmentId}"`)) {
      const m = /\*(S-[^*]+)\*/.exec(b.text?.text || '');
      if (m) return m[1];
    }
  }
  return null;
}

app.listen(config.port, () => {
  console.log(`slack-quote listening on http://localhost:${config.port}`);
  console.log(`  warp base:      ${config.warpBaseUrl}`);
  console.log(`  signing check:  ${config.skipSlackVerify ? 'SKIPPED (dev)' : 'enabled'}`);
  console.log(`  quote log:      ${config.quoteLogPath}`);
});
