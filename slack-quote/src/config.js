import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}. See .env.example.`);
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

// SLACK_SIGNING_SECRET is only required at request time — we let the process boot
// without it so `npm run smoke` and the tests can run offline.
export const config = {
  port: Number(optional('PORT', '3000')),
  warpBaseUrl: optional('WARP_API_BASE_URL', 'http://localhost:3001').replace(/\/$/, ''),
  warpApiKey: optional('WARP_API_KEY', 'mock'),
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET || '',
  quoteLogPath: optional('QUOTE_LOG_PATH', 'data/quotes.jsonl'),
  // Skip signature verification only when explicitly opted in (smoke tests).
  skipSlackVerify: process.env.SKIP_SLACK_VERIFY === '1',
  requireSecret() {
    return required('SLACK_SIGNING_SECRET');
  },
};
