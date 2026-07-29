// Slack gives us a per-command `response_url` we can POST to for up to 30 minutes
// after the initial request. That's how we work around the 3-second ack deadline:
// ack immediately with an ephemeral "working on it" message, do the slow call, then
// PUT the real answer here.

export async function respond(responseUrl, payload) {
  const res = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`response_url POST failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

// Build the shape Slack expects for a deferred reply. `replace_original: true` lets
// the final rate list overwrite the "working on it" ack in place, which reads better.
export function deferred({ text, blocks, ephemeral = false, replace = true }) {
  return {
    response_type: ephemeral ? 'ephemeral' : 'in_channel',
    replace_original: replace,
    text: text || ' ',
    ...(blocks ? { blocks } : {}),
  };
}
