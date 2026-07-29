# Warp Freight Desk for Slack

A small Slack app that lets a team run freight ops without leaving Slack:
rate-shop a lane, look up a shipment, pull docs and invoices.

- `/quote 90001 to 60601, 2 pallets, 1000 lbs` — rate-shop the lane, cheapest-first
- `/track S-1001-IN` — status, last location, latest events
- `/shipments` — recent shipments, each with an interactive **Details** button that
  expands to timeline + documents + invoice total

Built against the local Warp mock in [`../mock/`](../mock/). Point at the real Warp
API by changing one env var (`WARP_API_BASE_URL`) — every route and body shape is
identical.

---

## Run it

Two terminals, then optionally a third.

**1. Mock API**

```bash
node ../mock/server.js
```

**2. This app**

```bash
cp .env.example .env
# put a real SLACK_SIGNING_SECRET in .env (see "Wire it to Slack" below).
# WARP_API_BASE_URL already points at the mock.
npm install
npm run start        # or: npm run dev   (auto-reload)
```

App boots on `http://localhost:3000`.

**3. (Optional) Prove it works without a Slack workspace**

```bash
# in another terminal, while both servers above are running
SLACK_SIGNING_SECRET=smoke-secret APP_URL=http://localhost:3000 npm run smoke
```

Start the app with `SLACK_SIGNING_SECRET=smoke-secret` so the smoke script can sign
requests it accepts. The script fires each command against the real HTTP surface
(signed like Slack would) and captures the deferred `response_url` callbacks that a
real Slack workspace would receive. Great for a fast dev loop and for the recording.

**Run the tests**

```bash
npm test    # 25 tests, all node built-in — no jest/mocha
```

**See usage**

```bash
npm run report               # last 7 days: outcomes, lanes, users, p50/p95 latency
npm run report -- --all      # include /track and /shipments events too
```

---

## Wire it to Slack

Only needed when you want to run it inside a real workspace.

1. Free workspace at https://slack.com/get-started, then create an app at
   https://api.slack.com/apps → **From scratch**.
2. **Basic Information** → copy the **Signing Secret** into `.env` as
   `SLACK_SIGNING_SECRET`.
3. **OAuth & Permissions** → add bot scopes: `commands`, `chat:write`. Install to
   your workspace, copy the **Bot User OAuth Token** into `.env` as
   `SLACK_BOT_TOKEN` (this app doesn't currently need it — all responses go back
   through `response_url` — but it's here for anyone who wants to extend the app to
   post outside a slash-command context).
4. **Slash Commands** → create three commands, each pointing at
   `https://<your-public-url>/slack/commands`:
   - `/quote` — usage hint: `90001 to 60601, 2 pallets, 1000 lbs`
   - `/track` — usage hint: `S-1001-IN`
   - `/shipments`
5. **Interactivity & Shortcuts** → turn on, request URL:
   `https://<your-public-url>/slack/interactive`.
6. Expose your localhost with `ngrok http 3000` (or `cloudflared`, or a Render/Vercel
   deploy) and put that URL in the two spots above.

That's it. `SLACK_SIGNING_SECRET` is checked on every request; requests without a
valid `v0=` HMAC are rejected with 401.

Handy tracking numbers the mock knows about: `S-1001-IN` (in transit), `S-1002-DEL`
(delivered), `S-1003-CAN` (canceled). Handy order ids: `O-1001`, `O-1002`, `O-1004`.

---

## Decisions & tradeoffs

### The 3-second-ack problem

Slack drops any slash-command handler that doesn't reply in 3 seconds. The mock's
quote endpoint takes **4–16s, always over 3**. So the handler has to work in two
phases and the design falls out of that:

1. Parse the text, ack immediately with an ephemeral "getting rates…" block. Slack
   is happy in ~50ms.
2. Fire the slow `POST /freights/freight-quote` in the background, then POST the
   real result to the `response_url` Slack included in the original request.

That two-phase pattern is in [`src/handlers/quote.js`](src/handlers/quote.js) and
[`src/slack/respond.js`](src/slack/respond.js). It's the single thing this app has
to get right, and the smoke script (`npm run smoke`) proves it end to end by
capturing the deferred POST on a local port.

### Retry the flaky quote calls, but only twice

The mock returns `429`/`503` (with `Retry-After`) for ~15% of quote calls. The
[Warp client](src/warp.js) retries **429 and 503 only**, honors `Retry-After`
(capped at 5s so we don't leave the user staring at Slack for a minute), and gives
up after 2 retries with a typed `WarpError` the handler renders as a friendly
message. `400` and `404` are **not** retried — they're a user problem, not a
network problem.

I intentionally did not add a wall-clock retry budget on top of that. Slack's
`response_url` is valid for 30 minutes, so even 3 back-to-back 15-second attempts
is fine from Slack's side; the cap on retries is what keeps the caller sane, not
Slack.

### Normalize the mock's rough edges once, in one place

The rate-shop response comes back **unsorted**, with `transitTime` in **seconds**
(one is `0`), prices with long decimals, and one option **missing
`serviceLevel`**. All of that lives in
[`src/slack/blocks.js#normalizeOptions`](src/slack/blocks.js) — sort by rate
ascending, round prices to two decimals, convert seconds → days when the value is
large enough to obviously not be days already, treat `0` transit as unknown, and
render a missing service level explicitly (`_no service level_`) rather than
silently defaulting to "Standard". The unit test file makes that contract
explicit.

### JSONL log, not SQLite

The brief asks for enough logging to answer "how many quotes this week, on which
lanes." I picked append-only JSONL because it needs zero dependencies, is trivial
to `tail -f` during a demo, and it's obvious to a reviewer that we're actually
recording every call. `npm run report` shows how you'd answer the actual question
from the file. If quote volume ever grew, moving this to Postgres or a warehouse
would be a straight port — the fields already have the shape ("what was the
lane", "what did we return", "how long did it take").

### Interactivity: pack ids into `action.value`

The **Details** button on `/shipments` doesn't store anything server-side. The
`shipmentId` and `orderId` it needs are packed into `action.value` as JSON, and
the interactive endpoint reads them straight out. Keeps the app stateless and
means a restart mid-session doesn't strand any buttons.

### What I cut

- **Multi-workspace install / OAuth distribution.** Brief says one workspace is
  fine.
- **In-memory quote cache keyed by lane.** Would take ~15 lines and would help
  under repeated identical `/quote` calls. Left out because it complicates the
  "every quote is logged" story (do you log cache hits? do they count?), and the
  brief calls it stretch. Easy to add: a `Map<laneHash, {expires, options}>` in
  front of `warp.rateShop`.
- **A `/pagination` control on `/shipments`.** Mock has 7 shipments, page 1 shows
  5. A "Next" button would be one more block-action handler.
- **A background job/queue.** For a real deployment I'd move the fire-and-forget
  work behind a queue so a process restart doesn't lose an in-flight quote.
  In-process is fine for a demo but I'd flag it as the first thing to change for
  production.

### What I'd do next for production

1. **Deploy behind a queue** (SQS + a worker, or Cloudflare Queues) so pending
   quotes survive a restart and horizontally-scaled workers can share load.
2. **Replace JSONL with a real store** — Postgres for durability, plus a metrics
   pipe (Datadog / Prometheus) for latency and failure-rate dashboards.
3. **Idempotency**. If Slack retries a slash command (they do, on 5xx), we'd want
   to dedupe on `trigger_id` so we don't rate-shop twice for the same click.
4. **Alerting on the retry budget**. If the failure rate ever creeps past a few
   percent for real, that should page someone.
5. **A tiny UI on the log** — the report CLI is fine for one operator but a page
   at `/admin/quotes` with search would beat pinging me for stats.

---

## Code map

```
server.js                       # express app; routes /slack/commands + /interactive
src/
  config.js                     # env, one place
  warp.js                       # WarpClient — retry, timeout, typed WarpError
  parse.js                      # parseQuoteText — forgiving lane parser
  log.js                        # QuoteLog — JSONL append + readAll
  slack/
    verify.js                   # HMAC signature check (timing-safe)
    respond.js                  # deferred `response_url` helper
    blocks.js                   # normalizeOptions + all Block Kit builders
  handlers/
    quote.js                    # 3s-ack + deferred rate-shop
    track.js                    # single-call, ephemeral fallback on error
    shipments.js                # list + parallel details on button click
scripts/
  report.js                     # "how many quotes this week"
  smoke.js                      # end-to-end without a real Slack workspace
test/                           # node --test, no framework
```
