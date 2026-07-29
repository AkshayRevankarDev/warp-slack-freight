// Block Kit builders + the unit/sort/rounding pass that turns the mock's raw
// rate-shop output into something a human can actually read at 2pm on a busy day.

const MAX_ROWS = 8;

// ---- normalization -------------------------------------------------------

// The mock returns transitTime as raw seconds (e.g. 432000 = 5 days). The single-quote
// endpoint uses days directly. Heuristic: anything >= 1000 is seconds; anything smaller
// is already in days. transitTime === 0 means "unknown", not "same-day".
export function normalizeTransit(raw) {
  if (raw == null || raw === 0) return { days: null, label: '—' };
  const days = raw >= 1000 ? Math.round((raw / 86400) * 10) / 10 : raw;
  return { days, label: `${trimTrailing(days)} day${days === 1 ? '' : 's'}` };
}

function trimTrailing(n) {
  // 5.0 -> "5", 4.5 -> "4.5"
  return Number.isInteger(n) ? String(n) : String(n);
}

export function formatUSD(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

// Sort cheapest-first. Options that are missing a rate sink to the bottom rather than
// crashing sort with NaN. We also stamp `_serviceLevel` so downstream can render "—".
export function normalizeOptions(options) {
  const cleaned = (options || []).map((o) => ({
    id: o.id,
    carrierName: o.carrierName || o.carrierCode || 'Unknown carrier',
    carrierCode: o.carrierCode || null,
    rate: typeof o.rate === 'number' ? Math.round(o.rate * 100) / 100 : null,
    transit: normalizeTransit(o.transitTime),
    serviceLevel: o.serviceLevel || null,
    source: o.source || null,
  }));
  cleaned.sort((a, b) => {
    if (a.rate == null) return 1;
    if (b.rate == null) return -1;
    return a.rate - b.rate;
  });
  return cleaned;
}

// ---- Block Kit -----------------------------------------------------------

export function quoteBlocks({ lane, options, latencyMs, retriesUsed = 0 }) {
  const rows = options.slice(0, MAX_ROWS);
  const laneLine = `*${lane.originZip} → ${lane.destZip}*  ·  ${lane.pallets} pallet${lane.pallets === 1 ? '' : 's'}, ${lane.weightLbs} lbs  ·  pickup ${lane.pickupDate}`;
  const footer = `${options.length} option${options.length === 1 ? '' : 's'} · ${(latencyMs / 1000).toFixed(1)}s${retriesUsed ? ` · ${retriesUsed} retry${retriesUsed > 1 ? 'ies' : ''}` : ''}`;

  if (rows.length === 0) {
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `${laneLine}\n\n_No rates available for this lane._` } },
      contextBlock(footer),
    ];
  }

  const cheapest = rows[0];
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: laneLine } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Cheapest:* ${formatUSD(cheapest.rate)} — ${cheapest.carrierName} · ${cheapest.transit.label} · ${cheapest.serviceLevel || 'Standard'}`,
      },
    },
    { type: 'divider' },
  ];

  for (const o of rows) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${formatUSD(o.rate)}*  ·  ${o.carrierName}` +
          `\n${o.transit.label}  ·  ${o.serviceLevel || '_no service level_'}${o.source ? `  ·  _via ${o.source}_` : ''}`,
      },
    });
  }
  blocks.push(contextBlock(footer));
  return blocks;
}

export function errorBlocks({ title, detail, hint }) {
  const parts = [`*${title}*`];
  if (detail) parts.push(detail);
  if (hint) parts.push(`_${hint}_`);
  return [{ type: 'section', text: { type: 'mrkdwn', text: parts.join('\n') } }];
}

export function ackBlocks({ lane }) {
  return [
    { type: 'section', text: {
      type: 'mrkdwn',
      text: `:mag: Getting rates for *${lane.originZip} → ${lane.destZip}* — ${lane.pallets} pallet${lane.pallets === 1 ? '' : 's'}, ${lane.weightLbs} lbs.\nThis usually takes 5–15 seconds.`,
    } },
  ];
}

// ---- tracking / shipments ------------------------------------------------

const STATUS_EMOJI = {
  in_transit: ':truck:',
  delivered: ':white_check_mark:',
  canceled: ':x:',
  pending: ':hourglass:',
};

export function trackingBlocks({ trackingNumber, entry, events }) {
  if (!entry || entry.error === 'not_found') {
    return errorBlocks({
      title: `No shipment found for \`${trackingNumber}\``,
      hint: 'Try `/track S-1001-IN`, `/track S-1002-DEL`, or `/track S-1003-CAN`.',
    });
  }
  const status = entry.statusInfo?.status || 'unknown';
  const loc = entry.location ? `${entry.location.city}, ${entry.location.state}` : 'Location unknown';
  const updated = entry.statusInfo?.lastUpdated ? niceDate(entry.statusInfo.lastUpdated) : '';

  const blocks = [
    { type: 'section', text: {
      type: 'mrkdwn',
      text: `${STATUS_EMOJI[status] || ':package:'} *${trackingNumber}* — ${humanStatus(status)}\n${loc}${updated ? `  ·  _updated ${updated}_` : ''}`,
    } },
  ];

  const recent = (events?.data || []).slice(-4).reverse();
  if (recent.length) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: recent.map((e) => `• _${niceDate(e.when)}_ — ${e.message}`).join('\n') },
    });
  }
  return blocks;
}

export function shipmentsListBlocks({ shipments, page, pageSize, total }) {
  if (!shipments.length) {
    return errorBlocks({ title: 'No recent shipments.' });
  }
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Recent shipments* (${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total})` } },
    { type: 'divider' },
  ];
  for (const s of shipments) {
    const line = `${STATUS_EMOJI[s.status] || ':package:'} *${s.shipmentNumber}* — ${humanStatus(s.status)}\n` +
      `${s.pickup.city}, ${s.pickup.state} → ${s.delivery.city}, ${s.delivery.state}  ·  ${s.shipmentType}  ·  order \`${s.orderNumber}\``;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: line },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Details' },
        action_id: 'shipment_details',
        // We pack the ids we need into value so the interactive handler is stateless.
        value: JSON.stringify({ shipmentId: s.shipmentId, orderId: s.orderId }),
      },
    });
  }
  return blocks;
}

export function shipmentDetailsBlocks({ shipmentNumber, events, documents, invoice }) {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Details — ${shipmentNumber}*` } },
  ];

  if (events?.data?.length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Timeline*' } });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: events.data.map((e) => `• _${niceDate(e.when)}_ — ${e.message}`).join('\n') },
    });
  }

  if (documents?.data?.length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Documents*' } });
    const docLines = documents.data.map((d) => `• *${d.type.toUpperCase()}*: <${d.url}|download>`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: docLines.join('\n') } });
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_No documents on file._' }] });
  }

  if (invoice) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Invoice* — ${invoice.status.toUpperCase()}` } });
    const rows = [
      `Transit: ${formatUSD(invoice.transitCost)}`,
      `Fuel: ${formatUSD(invoice.fuelCost)}`,
    ];
    if (invoice.volumeDiscount) rows.push(`Volume discount: -${formatUSD(invoice.volumeDiscount)}`);
    for (const s of invoice.serviceOptions || []) rows.push(`${s.name}: ${formatUSD(s.amount)}`);
    rows.push(`*Total: ${formatUSD(invoice.grandTotal)}*`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: rows.join('\n') } });
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_No invoice on file._' }] });
  }

  return blocks;
}

function contextBlock(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function humanStatus(s) {
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function niceDate(iso) {
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
  } catch { return iso; }
}
