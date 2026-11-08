// k6 load test for agent-service chat (PRD: p95 time to first token < 4 s at expected peak).
//
//   k6 run loadtest/chat.js
//   k6 run -e AGENT_URL=https://chat.staging.yourstore.com -e PEAK_VUS=50 loadtest/chat.js
//   k6 run -e TOKEN="$(cat alice.jwt)" loadtest/chat.js      # logged-in turns (orders, cart)
//
// Every turn is a real model call and costs money: run it against staging, not production,
// and start small. Each virtual user is one shopper having a short conversation.
//
// Rate limits: agent-service allows RATE_LIMIT_PER_MIN (20) turns per shopper or, for guests,
// per IP. One load generator is one IP, so raise RATE_LIMIT_PER_MIN on the target for the run
// (and commerce-api's RATE_LIMIT_PER_MIN when using TOKEN). 429s are counted in
// `chat_rate_limited`, not hidden, and fail the run.
//
// First token: k6 only hands over the body once the stream ends, so it can't see the first
// text_delta. The 4 s bar is read from agent-service's own histogram,
// `agent.turn.first_token` (infra/monitoring/dashboard.json), while this runs. Here we check
// that turns finish, finish without error events, and how long they take.

import { check, fail, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const AGENT_URL = (__ENV.AGENT_URL || 'http://localhost:8000').replace(/\/$/, '');
const TOKEN = __ENV.TOKEN || '';
const PEAK_VUS = Number(__ENV.PEAK_VUS || 10);
const HOLD = __ENV.HOLD || '5m';

export const options = {
  scenarios: {
    chat: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: PEAK_VUS },
        { duration: HOLD, target: PEAK_VUS },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '60s', // let in-flight turns (up to 45 s) finish
    },
  },
  thresholds: {
    chat_turn_ok: ['rate>0.98'],
    chat_rate_limited: ['count==0'],
    chat_turn_duration: ['p(95)<20000'],
    // Time to response headers; the stream starts with `meta` before the model is called.
    chat_ttfb: ['p(95)<1000'],
  },
};

const turnOk = new Rate('chat_turn_ok');
const rateLimited = new Counter('chat_rate_limited');
const errorEvents = new Counter('chat_error_events');
const turnDuration = new Trend('chat_turn_duration', true);
const ttfb = new Trend('chat_ttfb', true);

// Mix of read-only questions (no confirm-first actions, nothing created for staff).
// Each list is one conversation; the second message relies on the first.
const GUEST_CONVERSATIONS = [
  ['Do you have waterproof running shoes?', 'Which one is cheapest?'],
  ['How long does shipping take?', 'And what is the return policy?'],
  ['I need a gift under $50', 'Show me something similar to the first one'],
  ['What categories do you sell?', 'Show me a few from the first category'],
];
const SHOPPER_CONVERSATIONS = [
  ['Where is my order ORD-1002?', 'When was it shipped?'],
  ['What is in my cart?', 'How much more for free shipping?'],
  ['Show my recent orders', 'Can I still return ORD-1001?'],
];

export function setup() {
  const res = http.get(`${AGENT_URL}/v1/config`);
  if (res.status !== 200 || !res.json('enabled'))
    fail(`assistant is not enabled at ${AGENT_URL} (GET /v1/config → ${res.status})`);
}

/** Parse an SSE body into [{event, data}]. */
function parseEvents(body) {
  const events = [];
  for (const block of String(body || '').split('\n\n')) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      events.push({ event, data: null });
    }
  }
  return events;
}

function turn(conversationId, message) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = http.post(
    `${AGENT_URL}/v1/chat`,
    JSON.stringify({ conversationId, message }),
    { headers, timeout: '60s', tags: { name: 'POST /v1/chat' } },
  );
  if (res.status === 429) {
    rateLimited.add(1);
    turnOk.add(false);
    return null;
  }
  ttfb.add(res.timings.waiting);
  turnDuration.add(res.timings.duration);

  const events = parseEvents(res.body);
  const errors = events.filter((e) => e.event === 'error');
  for (const e of errors) errorEvents.add(1, { code: String(e.data && e.data.code) });
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'stream ends with done': () => events.length > 0 && events[events.length - 1].event === 'done',
    'no error event': () => errors.length === 0,
    'assistant replied': () => events.some((e) => e.event === 'text_delta' || e.event === 'card'),
  });
  turnOk.add(ok);
  const meta = events.find((e) => e.event === 'meta');
  return (meta && meta.data && meta.data.conversationId) || conversationId;
}

export default function () {
  const pool = TOKEN ? SHOPPER_CONVERSATIONS : GUEST_CONVERSATIONS;
  const messages = pool[Math.floor(Math.random() * pool.length)];
  let conversationId = null; // agent-service starts a new one and returns its ID in `meta`
  for (const message of messages) {
    conversationId = turn(conversationId, message);
    if (!conversationId) break;
    sleep(5 + Math.random() * 10); // shopper reads the answer and types
  }
  sleep(5 + Math.random() * 20);
}
