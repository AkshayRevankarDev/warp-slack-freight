// Parse the free-form text a user types after `/quote`. Examples we accept:
//   "90001 to 60601, 2 pallets, 1000 lbs"
//   "from 90001 to 60601, 1 pallet 500lb"
//   "90001 -> 60601 3 pallets 1500 pounds pickup 2026-08-01"
//   "90001 60601 1000 lbs"               (single pallet assumed)
//
// We keep the parser deliberately forgiving: partial input still produces a lane;
// bad input returns a ParseError with a human message we can send back to Slack.

export class ParseError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ParseError';
    this.hint = hint || 'Try: `/quote 90001 to 60601, 2 pallets, 1000 lbs`';
  }
}

const ZIP = /\b(\d{5})\b/g;
const PALLETS = /(\d+)\s*(?:pallet|plt|pallets|plts)\b/i;
const WEIGHT = /(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound|pounds)\b/i;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

export function parseQuoteText(raw) {
  if (!raw || !raw.trim()) {
    throw new ParseError('Missing lane and weight.');
  }
  const text = raw.trim();

  const zips = [...text.matchAll(ZIP)].map((m) => m[1]);
  if (zips.length < 2) {
    throw new ParseError('Need both origin and destination ZIPs.');
  }
  // If more than 2 zip-looking numbers appear (e.g. someone included "1000" — but ZIP is
  // 5 digits so 1000 won't match), the first two wins by user intent (origin, then dest).
  const [originZip, destZip] = zips;

  const pallets = matchInt(text, PALLETS) ?? 1;   // default: one pallet
  const weightLbs = matchFloat(text, WEIGHT);
  if (weightLbs === null) {
    throw new ParseError('Missing weight (e.g. `1000 lbs`).');
  }

  const pickupDate = matchDate(text, DATE) || nextBusinessDayISO();

  // Standard pallet dims per the brief. Only used to fill the API payload — we don't
  // ask the user for them and we don't show them back.
  const item = {
    quantity: pallets,
    weight: { value: weightLbs, unit: 'lbs' },
    length: { value: 48, unit: 'in' },
    width: { value: 40, unit: 'in' },
    height: { value: 48, unit: 'in' },
  };

  return {
    originZip,
    destZip,
    pallets,
    weightLbs,
    pickupDate,
    payload: {
      pickupDate,
      pickupInfo: { zipcode: originZip },
      deliveryInfo: { zipcode: destZip },
      listItems: [item],
    },
  };
}

function matchInt(text, re) {
  const m = text.match(re);
  return m ? parseInt(m[1], 10) : null;
}
function matchFloat(text, re) {
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}
function matchDate(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

// Next US business day (Mon-Fri). Uses UTC to keep tests deterministic across TZs.
export function nextBusinessDayISO(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
