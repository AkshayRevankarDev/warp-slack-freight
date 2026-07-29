import { respond, deferred } from '../slack/respond.js';
import { shipmentsListBlocks, shipmentDetailsBlocks, errorBlocks } from '../slack/blocks.js';

export function makeShipmentsHandler({ warp, log }) {
  return async function handleShipments(cmd) {
    const started = Date.now();
    try {
      const { data, page, pageSize, total } = await warp.shipments({ page: 1, pageSize: 5 });
      log.record({ kind: 'shipments', slack: slackMeta(cmd), latencyMs: Date.now() - started, count: data.length });
      return { ack: {
        response_type: 'in_channel',
        blocks: shipmentsListBlocks({ shipments: data, page, pageSize, total }),
      } };
    } catch (e) {
      log.record({ kind: 'shipments', slack: slackMeta(cmd), outcome: 'error', error: e.message, latencyMs: Date.now() - started });
      return { ack: {
        response_type: 'ephemeral',
        blocks: errorBlocks({ title: 'Could not load shipments.', detail: e.message }),
      } };
    }
  };
}

// Called from the interactive endpoint when a "Details" button is clicked.
export function makeShipmentDetailsHandler({ warp, log }) {
  return async function handleDetails({ shipmentId, orderId, shipmentNumber, responseUrl, slack }) {
    const started = Date.now();
    // Fire the three lookups in parallel — nothing depends on anything else.
    const [events, documents, invoice] = await Promise.all([
      warp.events(shipmentId).catch((e) => ({ _error: e })),
      warp.documents(orderId).catch((e) => ({ _error: e })),
      warp.invoice(orderId).catch((e) => ({ _error: e })),
    ]);

    const blocks = shipmentDetailsBlocks({
      shipmentNumber: shipmentNumber || shipmentId,
      events: events?._error ? null : events,
      documents: documents?._error ? null : documents,
      invoice: invoice?._error ? null : invoice,
    });

    log.record({
      kind: 'shipment_details', slack, shipmentId, orderId,
      latencyMs: Date.now() - started,
      errors: [events, documents, invoice].filter((r) => r?._error).map((r) => r._error.message),
    });

    // We're on the interactive path, so we always POST back to response_url — the
    // button click already got its 3s ack from the empty 200 the endpoint returned.
    await respond(responseUrl, deferred({ text: 'Shipment details', blocks, replace: false, ephemeral: true }));
  };
}

function slackMeta(cmd) {
  return { user: cmd.user_name || cmd.user_id, channel: cmd.channel_name || cmd.channel_id, team: cmd.team_id };
}
