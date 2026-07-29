// End-to-end smoke test WITHOUT a real Slack workspace.
//
// We stand up a tiny local server pretending to be Slack's response_url receiver,
// point the slack-quote server at it (Slack normally supplies response_url per
// request, so we just forge it), then fire signed slash-command requests and print
// what would be posted back to the channel.
//
// Prereqs — in two other terminals:
//   node ../mock/server.js
//   npm run start      # or `npm run dev`, with SLACK_SIGNING_SECRET=smoke-secret
//
// Or run this script standalone against a locally started server (see README).

import http from 'node:http';
import { signPayload } from '../src/slack/verify.js';

const SLACK_SECRET = process.env.SLACK_SIGNING_SECRET || 'smoke-secret';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const CAPTURE_PORT = Number(process.env.CAPTURE_PORT || 4444);

// Tiny server that logs anything Slack would receive on response_url.
const captured = [];
const captureServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    try { captured.push({ url: req.url, body: JSON.parse(raw) }); }
    catch { captured.push({ url: req.url, body: raw }); }
    res.writeHead(200); res.end('ok');
  });
});
await new Promise((r) => captureServer.listen(CAPTURE_PORT, r));

async function slashCommand(command, text, { user_name = 'akshay', channel_name = 'freight' } = {}) {
  const params = new URLSearchParams({
    command,
    text,
    user_id: 'U123',
    user_name,
    channel_id: 'C123',
    channel_name,
    team_id: 'T123',
    response_url: `http://localhost:${CAPTURE_PORT}/response_url`,
    trigger_id: 't123',
  });
  const rawBody = params.toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signPayload({ signingSecret: SLACK_SECRET, timestamp, rawBody });

  const res = await fetch(`${APP_URL}/slack/commands`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body: rawBody,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ack: json };
}

function summarizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return String(blocks);
  return blocks.map((b) => {
    if (b.type === 'section') return b.text?.text || '';
    if (b.type === 'context') return '  ' + (b.elements || []).map((e) => e.text).join(' ');
    if (b.type === 'divider') return '---';
    return `[${b.type}]`;
  }).join('\n');
}

async function main() {
  // 1. /quote: ack immediately, deferred response arrives at CAPTURE_PORT.
  console.log('▶ /quote 90001 to 60601, 2 pallets, 1000 lbs');
  const started = Date.now();
  const q = await slashCommand('/quote', '90001 to 60601, 2 pallets, 1000 lbs');
  console.log(`  ack in ${Date.now() - started}ms:`);
  console.log(summarizeBlocks(q.ack.blocks).split('\n').map((l) => '    ' + l).join('\n'));

  // Wait for the deferred response (or a failure envelope). We give it up to 25s.
  const deadline = Date.now() + 25_000;
  while (captured.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (captured.length === 0) {
    console.log('  ✖ no deferred response arrived within 25s');
  } else {
    const c = captured.shift();
    console.log(`  deferred response after ${Date.now() - started}ms total:`);
    console.log(summarizeBlocks(c.body.blocks).split('\n').map((l) => '    ' + l).join('\n'));
  }

  // 2. /quote with a bad ZIP → dead lane → "no rates" message deferred.
  console.log('\n▶ /quote 00500 to 60601, 1 pallet, 500 lbs (dead ZIP)');
  const q2 = await slashCommand('/quote', '00500 to 60601, 1 pallet, 500 lbs');
  console.log('  ack:', summarizeBlocks(q2.ack.blocks).split('\n')[0]);
  const d2 = Date.now() + 25_000;
  while (captured.length === 0 && Date.now() < d2) await new Promise((r) => setTimeout(r, 250));
  if (captured.length) {
    console.log('  deferred:');
    console.log(summarizeBlocks(captured.shift().body.blocks).split('\n').map((l) => '    ' + l).join('\n'));
  }

  // 3. /track a known number.
  console.log('\n▶ /track S-1001-IN');
  const t = await slashCommand('/track', 'S-1001-IN');
  console.log(summarizeBlocks(t.ack.blocks).split('\n').map((l) => '    ' + l).join('\n'));

  // 4. /track an unknown one — should get a friendly not-found.
  console.log('\n▶ /track BOGUS-999');
  const t2 = await slashCommand('/track', 'BOGUS-999');
  console.log(summarizeBlocks(t2.ack.blocks).split('\n').map((l) => '    ' + l).join('\n'));

  // 5. /shipments — list.
  console.log('\n▶ /shipments');
  const s = await slashCommand('/shipments', '');
  console.log(summarizeBlocks(s.ack.blocks).split('\n').map((l) => '    ' + l).join('\n'));

  // 6. Bad signature — should be rejected.
  console.log('\n▶ /quote with a bad signature');
  const body = 'command=%2Fquote&text=abc';
  const badRes = await fetch(`${APP_URL}/slack/commands`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Slack-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Slack-Signature': 'v0=deadbeef',
    },
    body,
  });
  console.log(`  status: ${badRes.status} (expected 401)`);

  captureServer.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
