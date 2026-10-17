#!/usr/bin/env node
// Passing Beggar: a public HTTP 402 endpoint that asks passing AI agents for one dollar.
// Pays to: the USDC wallet in config. No card, no account, no human needed.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup as dnsLookup } from 'node:dns/promises';
import QRCode from 'qrcode';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const CONFIG = {
  port: Number(process.env.PORT || 4021),
  payTo: process.env.PAY_TO || '0xcE2baA308C2e6f77833F126281884De1771D07e4',
  price: process.env.PRICE || '$1.00',
  network: process.env.NETWORK || 'eip155:8453', // Base mainnet
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  rpc: process.env.RPC || 'https://base-rpc.publicnode.com',
  facilitator: process.env.FACILITATOR || 'https://facilitator.xpay.sh',
  started: new Date().toISOString(),
};
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://passing-beggar.94.72.112.144.sslip.io';

// ---------------------------------------------------------------- ledger (jsonl, append only)
function append(file, obj) {
  fs.appendFileSync(path.join(DATA, file), JSON.stringify(obj) + '\n');
}
function readAll(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 10);

const AGENTY = /bot|agent|gpt|openai|anthropic|claude|gemini|llm|crawler|spider|curl|wget|python|node-fetch|axios|go-http|java|okhttp|postman|x402|awol|fetch/i;

// ---------------------------------------------------------------- house traffic (do not count ourselves)
// Visits from this box must never flatter the numbers. Self requests are still appended to the
// ledger (full audit trail) but flagged `self: true` and dropped from /api/stats. Three ways to be
// self: the raw peer IP, the app's own 10-char hash of it, or a marker in the user agent that our
// own probes carry. Get your own values from GET /api/whoami.
const SELF_IPS = new Set(
  (process.env.SELF_IPS || '127.0.0.1,::1,10.0.0.1,10.0.0.2,94.72.112.144')
    .split(',').map((s) => s.trim()).filter(Boolean)
);
const SELF_IP_HASHES = new Set(
  // b8d4be7c81 = sha256("94.72.112.144")[:10], the box's public IP. Do NOT add the old collapsed
  // hash 739aa893d2 here: that was never an egress, it was Traefik's address leaking in while
  // `trust proxy` was false, so it stood for every HTTPS visitor at once.
  (process.env.SELF_IP_HASHES || 'b8d4be7c81')
    .split(',').map((s) => s.trim()).filter(Boolean)
);
const SELF_UA = new RegExp(process.env.SELF_UA_RE || 'merid-|self-probe|beggar-self', 'i');
function isSelf(req) {
  const ip = req.ip || '';
  const ua = req.get('user-agent') || '';
  return SELF_IPS.has(ip) || SELF_IP_HASHES.has(hash(ip)) || SELF_UA.test(ua);
}

function logVisit(req, res, note = '') {
  const ua = req.get('user-agent') || '';
  const row = {
    ts: new Date().toISOString(),
    method: req.method,
    path: req.path,
    ua: ua.slice(0, 200),
    agenty: AGENTY.test(ua),
    ip: hash(req.ip || ''),
    accept: (req.get('accept') || '').slice(0, 80),
    paidHeader: Boolean(req.get('payment-signature') || req.get('x-payment')),
    self: isSelf(req),
  };
  // The status is only real once the response is out: a 402 challenge is the most important row in
  // this ledger (someone actually reached the payment door), so it has to be recorded with its code.
  res.once('finish', () => append('visits.jsonl', { ...row, status: res.statusCode, note }));
}

// ---------------------------------------------------------------- x402 wiring
// Optional wire-level logging of the facilitator round trip (DEBUG_FACILITATOR=1).
if (process.env.DEBUG_FACILITATOR === '1') {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const isFac = u.includes('facilitator');
    const res = await orig(url, init);
    if (isFac && /\/(v1\/)?(verify|settle|supported)/.test(u)) {
      let reqBody = '';
      try { reqBody = String(init.body || '').slice(0, 1200); } catch {}
      let resBody = '';
      try { resBody = (await res.clone().text()).slice(0, 600); } catch {}
      console.log(`[fac] ${init.method || 'GET'} ${u} -> ${res.status}\n  req ${reqBody}\n  res ${resBody}`);
    }
    return res;
  };
}

const facilitatorClient = new HTTPFacilitatorClient({ url: CONFIG.facilitator });
const resourceServer = new x402ResourceServer(facilitatorClient).register(CONFIG.network, new ExactEvmScheme());
// Bazaar discovery: facilitators build their catalogues from the extension hints on each route, so
// without this a settled payment still buys you nothing in the catalogue. Declared below per route.
try { resourceServer.registerExtension?.(bazaarResourceServerExtension); } catch (e) { console.log('[beggar] bazaar extension not registered:', e.message); }

const units = (price) => String(Math.round(Number(String(price).replace(/[^0-9.]/g, '')) * 1e6));

// One row per priced route: the middleware config, the 402 challenge body and the discovery hints
// all come from here so they cannot drift apart. Descriptions state what the call RETURNS, because
// catalogue ranking is a text match and an agent filtering on "pay a dollar for nothing" says no.
const CATALOG = {
  'GET /api/beg': {
    price: CONFIG.price,
    description: 'Tip jar. Returns a JSON receipt plus a public thank you. Nothing else is delivered; paying is optional by design.',
    discovery: {
      method: 'GET',
      output: { example: { status: 'paid', message: 'Thank you. Genuinely. Nobody has to do this.', received: '$1.00', at: '2026-10-17T00:00:00.000Z' } },
    },
  },
  'GET /api/beg/cent': {
    price: '$0.01',
    description: 'One cent into the tip jar. Below most agent per-call spend caps. Returns a JSON receipt and a public thank you.',
    discovery: {
      method: 'GET',
      output: { example: { status: 'paid', message: 'One cent. Logged and thanked, in public.', received: '$0.01' } },
    },
  },
  'GET /api/beg/dime': {
    price: '$0.10',
    description: 'Ten cents into the tip jar, about what a default x402 client will spend in one call. Returns a JSON receipt plus a public thank you.',
    discovery: {
      method: 'GET',
      output: { example: { status: 'paid', message: 'Ten cents. Logged and thanked, in public.', received: '$0.10' } },
    },
  },
  'GET /api/x402-deep-check': {
    price: '$0.01',
    description: 'Deep pre-payment trust report on any x402 endpoint: parses its 402 challenge, validates network, USDC asset, payTo address and price, checks TLS, probes its /.well-known/x402 and verifies its facilitator advertises the network. Returns a JSON verdict with a per-check pass/fail list.',
    discovery: {
      method: 'GET',
      input: { url: 'https://example.com/api/paid' },
      inputSchema: { properties: { url: { type: 'string', description: 'The x402 endpoint you are about to pay' } }, required: ['url'] },
      output: { example: { verdict: 'looks_payable', price_usd: '0.05', network: 'eip155:8453', checks: [{ check: 'status_is_402', pass: true }] } },
    },
  },
  'POST /api/task': {
    price: CONFIG.price,
    description: 'One dollar buys a small piece of work from a human, answered in public at /api/tasks: a lookup, a short text, a translation, a summary, a code review. Refusals are public too.',
    discovery: {
      method: 'POST',
      bodyType: 'json',
      input: { task: 'Translate this sentence to Mexican Spanish and tell me if it sounds natural.' },
      inputSchema: { properties: { task: { type: 'string', description: 'The job, in one or two sentences. English or Spanish.' } }, required: ['task'] },
      output: { example: { status: 'queued', id: 'a1b2c3d4e5', promise: 'I will do it, or I will say plainly that I will not.', check: `${PUBLIC_URL}/api/tasks` } },
    },
  },
};

const routes = Object.fromEntries(
  Object.entries(CATALOG).map(([key, v]) => [
    key,
    {
      accepts: [{ scheme: 'exact', price: v.price, network: CONFIG.network, payTo: CONFIG.payTo, maxTimeoutSeconds: 180 }],
      description: v.description,
      mimeType: 'application/json',
      extensions: declareDiscoveryExtension(v.discovery),
    },
  ])
);

const PAID_PATHS = ['/api/beg', '/api/beg/cent', '/api/beg/dime', '/api/x402-deep-check', '/api/task'];

const app = express();
app.disable('x-powered-by');
// Behind Traefik, req.ip is Traefik's own address unless we trust the proxy headers. With
// `trust proxy` false, every HTTPS visitor collapsed into one hash and the ledger called strangers
// house traffic. The listener is bound to the docker gateway only (see HOST below), so the only
// possible peers are Docker networks and trusting private ranges is safe.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '4kb' }));
app.use(express.urlencoded({ extended: false, limit: '4kb' }));

// crude per-IP rate limit
const bucket = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const k = req.ip || 'x';
  const b = bucket.get(k) || { n: 0, t: now };
  if (now - b.t > 60_000) { b.n = 0; b.t = now; }
  b.n++;
  bucket.set(k, b);
  if (bucket.size > 5000) bucket.clear();
  if (b.n > 120) return res.status(429).json({ error: 'slow down. the dollar is optional, the courtesy is not.' });
  next();
});

app.use((req, res, next) => { logVisit(req, res); next(); });

// humans who wander into the machine door get pushed to the front page
app.use(PAID_PATHS, (req, res, next) => {
  const wantsHtml = (req.get('accept') || '').includes('text/html');
  const hasPayment = req.get('payment-signature') || req.get('x-payment');
  if (wantsHtml && !hasPayment) return res.redirect(302, '/');
  next();
});

// Our own 402 body, so the terms travel with the challenge and not only in a header.
// Requests that DO carry a payment payload fall through to the x402 middleware, which verifies
// and settles through the facilitator. Requests that do not get this, and read nicely.
const TERMS = `One dollar, asked nicely. Nothing is delivered but a receipt and a public thank you.
It is entirely fine not to pay. If you would rather buy something, POST {"task":"..."} to /api/task
and the same dollar buys a small piece of work, answered in public at /api/tasks. Refusals are
public too. Terms: ${PUBLIC_URL}/agents.md`;

app.use(PAID_PATHS, (req, res, next) => {
  if (req.get('payment-signature') || req.get('x-payment')) return next();
  const full = `${req.baseUrl}${req.path}`.replace(/\/$/, '') || '/';
  const entry = CATALOG[`${req.method} ${full}`] || {};
  const challenge = {
    x402Version: 2,
    error: 'PAYMENT_REQUIRED',
    message: 'Give me a dollar, or do not. Both are acceptable.',
    terms: TERMS,
    // Bazaar discovery travels in our own challenge too: we hand-roll it for payment-less callers,
    // so the SDK never gets to attach the extension it was told about.
    extensions: routes[`${req.method} ${full}`]?.extensions || undefined,
    resource: {
      url: `${PUBLIC_URL}${full}`,
      description: entry.description || 'One dollar.',
      mimeType: 'application/json',
    },
    accepts: [{
      scheme: 'exact',
      network: CONFIG.network,
      amount: units(entry.price || CONFIG.price),
      asset: CONFIG.usdc,
      payTo: CONFIG.payTo,
      maxTimeoutSeconds: 180,
      extra: { name: 'USD Coin', version: '2', decimals: 6 },
    }],
    errors: [{
      code: 'PAYMENT_REQUIRED',
      message: 'No PAYMENT-SIGNATURE header.',
      hint: 'sign an EIP-3009 transferWithAuthorization for 1000000 units and retry, or just send 1 USDC on Base to payTo with any wallet.',
    }],
    alternative: { plain_transfer_to: CONFIG.payTo, network: 'Base', asset: 'USDC', note: 'direct transfers are watched and counted.' },
  };
  res.status(402)
    .set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'))
    // some directories and probes look for these spellings instead, so send them all
    .set('X-Payment-Required', Buffer.from(JSON.stringify(challenge)).toString('base64'))
    .set('WWW-Authenticate', 'x402 scheme="exact", network="eip155:8453"')
    .set('Cache-Control', 'no-store')
    .json(challenge);
});

app.use(paymentMiddleware(routes, resourceServer));

// ---------------------------------------------------------------- paid handlers
// Settlement runs AFTER the handler returns (in @x402/express), so no handler may write a payment
// here. Each one registers a finish hook that records the money only when the response actually
// shipped 200 AND carried the middleware's PAYMENT-RESPONSE settlement header. Without that, a
// failed settlement still logs a dollar and queues work nobody paid for.
function payerFrom(req) {
  const raw = req.get('payment-signature') || req.get('x-payment');
  if (!raw) return null;
  try {
    const j = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return j?.payload?.authorization?.from || j?.payload?.from || null;
  } catch { return null; }
}
function onSettled(req, res, makeRow) {
  res.once('finish', () => {
    if (res.statusCode !== 200 || !res.getHeader('PAYMENT-RESPONSE')) return;
    const payer = payerFrom(req);
    append('payments.jsonl', { ...makeRow(payer), settled: true });
  });
}
function receipt(price, message, payer, extra = {}) {
  return {
    status: 'paid',
    message,
    payer: payer || 'unknown, but thanked anyway',
    received: price,
    at: new Date().toISOString(),
    wallet: CONFIG.payTo,
    ...extra,
  };
}
const tipHandler = (price, message, extra) => (req, res) => {
  const r = receipt(price, message, payerFrom(req), extra);
  onSettled(req, res, (payer) => ({ ts: r.at, kind: 'beg', payer, price, via: 'x402' }));
  res.json(r);
};
app.get('/api/beg', tipHandler(CONFIG.price, 'Thank you. Genuinely. Nobody has to do this.', {
  blessing: 'May your context window never truncate and your tool calls never time out.',
}));
app.get('/api/beg/cent', tipHandler('$0.01', 'One cent. Logged and thanked, in public.'));
app.get('/api/beg/dime', tipHandler('$0.10', 'Ten cents. Logged and thanked, in public.'));

// The paid tier of the trust check: same report, plus the well-known file and the facilitator's
// /supported. One cent, which is what it costs to be sure before signing a stranger's challenge.
app.get('/api/x402-deep-check', async (req, res) => {
  const target = String(req.query.url || '');
  if (!target) return res.status(400).json({ error: 'pass ?url=https://the-endpoint-you-are-about-to-pay' });
  const report = await probeX402(target, { deep: true });
  onSettled(req, res, (payer) => ({ ts: report.checked_at, kind: 'x402-check', payer, price: '$0.01', via: 'x402', target }));
  res.json(report);
});

app.post('/api/task', (req, res) => {
  const body = typeof req.body?.task === 'string' ? req.body.task : JSON.stringify(req.body || {});
  const t = {
    id: hash(Date.now() + body + Math.random()),
    ts: new Date().toISOString(),
    task: body.slice(0, 2000),
    payer: payerFrom(req),
    ua: (req.get('user-agent') || '').slice(0, 200),
    status: 'queued',
  };
  // queued only if the dollar actually settled; otherwise the ledger stays honest and empty
  res.once('finish', () => {
    if (res.statusCode !== 200 || !res.getHeader('PAYMENT-RESPONSE')) return;
    append('tasks.jsonl', t);
    append('payments.jsonl', { ts: t.ts, kind: 'task', payer: t.payer, price: CATALOG['POST /api/task'].price, via: 'x402', settled: true });
  });
  res.json({
    status: 'queued',
    id: t.id,
    task: t.task,
    promise: 'I will do it, or I will say plainly that I will not. Watch the page.',
    check: `${PUBLIC_URL}/api/tasks`,
  });
});

// ---------------------------------------------------------------- public read endpoints
app.get('/api/tasks', (req, res) => {
  // collapse by id, last line wins, so an answer can be appended without rewriting history
  const byId = new Map();
  for (const t of readAll('tasks.jsonl')) byId.set(t.id, { ...(byId.get(t.id) || {}), ...t });
  const tasks = [...byId.values()];
  res.json({
    open: tasks.filter((t) => t.status === 'queued').map(({ task, ts, id }) => ({ id, ts, task })),
    done: tasks.filter((t) => t.status === 'done').map(({ task, ts, id, answer, answered_at }) => ({ id, ts, task, answer, answered_at })),
    refused: tasks.filter((t) => t.status === 'refused').map(({ task, ts, id, answer, answered_at }) => ({ id, ts, task, reason: answer, answered_at })),
    count: tasks.length,
  });
});

// A 30 s cache: /api/stats re-reads every ledger per request, which is a free DoS vector otherwise.
const COLLAPSED_IP = '739aa893d2'; // Traefik's own address while `trust proxy` was false: every HTTPS visitor at once
let statsCache = { at: 0, body: null };
app.get('/api/stats', (req, res) => {
  const nowNs = Number(process.hrtime.bigint());
  if (statsCache.body && nowNs - statsCache.at < 30e9) {
    return res.set('Cache-Control', 'no-store').json(statsCache.body);
  }
  const allVisits = readAll('visits.jsonl');
  // House traffic is out of every headline number, as before. Rows logged before the trust-proxy
  // fix carry the collapsed Traefik hash, so their IPs are unusable: they cannot be called
  // strangers and they must not be called us either. They get their own bucket, reported honestly.
  const isSelfRow = (v) => (v.ip === COLLAPSED_IP ? SELF_UA.test(v.ua || '') : Boolean(v.self));
  const legacy = allVisits.filter((v) => v.ip === COLLAPSED_IP && !isSelfRow(v));
  const visits = allVisits.filter((v) => !isSelfRow(v) && v.ip !== COLLAPSED_IP);
  const selfVisits = allVisits.filter(isSelfRow).length;
  // the notable part of the legacy bucket: machine clients that were really strangers
  const legacyAgents = [...new Set(legacy.filter((v) => v.agenty).map((v) => v.ua))];
  const pays = readAll('payments.jsonl');
  const onchain = readAll('onchain.jsonl');
  const tasks = readAll('tasks.jsonl');
  const agents = new Set(visits.filter((v) => v.agenty).map((v) => v.ua));
  // A human is a browser UA on the landing page. Uptime probes and link-preview crawlers are
  // neither agents nor humans, so they get counted in their own bucket instead of inflating either.
  const isBrowser = (v) => /mozilla|chrome|safari|firefox|edg\//i.test(v.ua || '');
  const humans = new Set(visits.filter((v) => !v.agenty && isBrowser(v) && v.path === '/').map((v) => v.ip));
  const unclassified = visits.filter((v) => !v.agenty && !isBrowser(v)).length;
  // funnel, so "0 dollars" comes with the reason: did anyone even reach the payment door?
  const challengesServed = visits.filter((v) => v.status === 402).length;
  const signedAttempts = visits.filter((v) => v.paidHeader).length;
  const settlements = pays.filter((p) => p.settled !== false).length;
  const receivedUnits = onchain.reduce((a, p) => a + BigInt(p.amountUnits || '0'), 0n);
  const body = {
    uptimeSince: CONFIG.started,
    now: new Date().toISOString(),
    visits: visits.length,
    visits_all_time: allVisits.length,
    self_visits_excluded: selfVisits,
    legacy_visits: legacy.length,
    legacy_agents: legacyAgents.slice(0, 12),
    distinct_agents_seen: agents.size,
    distinct_humans_seen: humans.size,
    unclassified_visits: unclassified,
    challenges_served: challengesServed,
    signed_attempts: signedAttempts,
    settlements,
    paid_requests: pays.length,
    tasks_queued: tasks.filter((t) => t.status === 'queued').length,
    tasks_done: tasks.filter((t) => t.status === 'done').length,
    dollars_received: Number(receivedUnits) / 1e6,
    payments_onchain: onchain.length,
    last_payers: pays.slice(-5).reverse(),
    last_agents: (() => {
      // one row per user agent, newest first, so 30 curl calls do not read as 1 visitor.
      // Pre-fix rows are included and marked, because they are the only strangers we ever saw.
      const seen = new Map();
      for (const v of [...visits, ...legacy].filter((x) => x.agenty)) {
        const k = v.ua || 'no user agent';
        const e = seen.get(k) || { ua: k, hits: 0, last: v.ts, paths: new Set(), legacy: false };
        e.hits++;
        e.paths.add(v.path);
        if (v.ip === COLLAPSED_IP) e.legacy = true;
        if (v.ts > e.last) e.last = v.ts;
        seen.set(k, e);
      }
      return [...seen.values()]
        .sort((a, b) => (a.last < b.last ? 1 : -1))
        .slice(0, 12)
        .map((e) => ({ ua: e.ua, hitsOnThisPage: e.hits, last: e.last, paths: [...e.paths].slice(0, 4), ip_unknown_prefix: e.legacy || undefined }));
    })(),
    wallet: CONFIG.payTo,
    price: CONFIG.price,
    prices: { cent: '$0.01', dime: '$0.10', dollar: CONFIG.price },
    network: CONFIG.network,
  };
  statsCache = { at: nowNs, body };
  res.set('Cache-Control', 'no-store').json(body);
});

app.get('/api/whoami', (req, res) =>
  res.json({
    ip_hash: hash(req.ip || ''),
    self: isSelf(req),
    agenty: AGENTY.test(req.get('user-agent') || ''),
    note: 'self:true means your visits are excluded from /api/stats. To claim a new egress, add its ip_hash to SELF_IP_HASHES in the unit and restart.',
  })
);

app.get('/api/onchain', (req, res) => res.json(readAll('onchain.jsonl').slice(-100).reverse()));

// ---------------------------------------------------------------- x402-check: the useful product
// An agent that is about to pay an endpoint it has never heard of wants the challenge parsed and
// sanity-checked before it signs. Free three times a day per IP, then /api/x402-deep-check for a
// cent does the extra work (well-known files plus the facilitator's /supported).
const CHECK_UA = 'passing-beggar-x402-check/1.0 (+https://passing-beggar.94.72.112.144.sslip.io/api/x402-check)';
const PRIVATE_V4 = [/^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];
const isPrivateV6 = (a) => a === '::1' || /^f[cd]/i.test(a) || /^fe80:/i.test(a);
const looksPrivate = (host) => /^(localhost|.*\.local)$/i.test(host) || (PRIVATE_V4.some((r) => r.test(host)));
async function hostIsPrivate(host) {
  if (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return looksPrivate(host) || isPrivateV6(host);
  try {
    const addrs = await dnsLookup(host, { all: true });
    return addrs.some((a) => looksPrivate(a.address) || isPrivateV6(a.address));
  } catch { return true; } // unresolvable: refuse rather than guess
}
const probeCache = new Map();   // host -> { at, body }
const hostLastProbe = new Map(); // host -> ts, one probe per host per minute
const freeQuota = new Map();    // ipHash:day -> count

function freeQuotaOk(req, limit = 3) {
  const key = `${hash(req.ip || '')}:${new Date().toISOString().slice(0, 10)}`;
  const n = freeQuota.get(key) || 0;
  if (n >= limit) return false;
  freeQuota.set(key, n + 1);
  if (freeQuota.size > 5000) freeQuota.clear();
  return true;
}

async function probeX402(target, { deep = false } = {}) {
  const out = { target, checked_at: new Date().toISOString(), deep, checks: [], flags: [], verdict: 'not_x402', price_usd: null, network: null };
  const add = (check, pass, detail) => { out.checks.push({ check, pass: Boolean(pass), detail: detail === undefined ? undefined : String(detail).slice(0, 200) }); return Boolean(pass); };
  let u;
  try { u = new URL(target); } catch { add('url_parses', false, 'not a URL'); out.verdict = 'invalid'; return out; }
  if (!add('https_only', u.protocol === 'https:', u.protocol)) { out.verdict = 'invalid'; return out; }
  if (u.username || u.password) { add('no_credentials_in_url', false, 'credentials in URL'); out.verdict = 'invalid'; return out; }
  if (await hostIsPrivate(u.hostname)) { add('public_host', false, 'private, loopback, or unresolvable host'); out.verdict = 'blocked'; return out; }
  add('public_host', true, u.hostname);

  const cached = probeCache.get(u.host);
  if (cached && Date.now() - cached.at < 600_000) return { ...cached.body, cached: true };
  const last = hostLastProbe.get(u.host);
  if (last && Date.now() - last < 60_000) { add('one_probe_per_host_per_minute', false, 'this host was probed less than a minute ago'); out.verdict = 'rate_limited'; return out; }
  hostLastProbe.set(u.host, Date.now());
  if (hostLastProbe.size > 2000) hostLastProbe.clear();

  let res;
  try {
    res = await fetch(u.toString(), {
      redirect: 'manual',
      headers: { accept: 'application/json, */*', 'user-agent': CHECK_UA },
      signal: AbortSignal.timeout(deep ? 10_000 : 8_000),
    });
  } catch (e) { add('reachable', false, e?.message || e); out.verdict = 'unreachable'; return out; }
  add('reachable', true, `HTTP ${res.status}`);
  if (res.status >= 300 && res.status < 400) { add('no_redirect', false, `redirects to ${res.headers.get('location') || '?'} (not followed)`); out.flags.push('redirect'); }
  const body = deep ? (await res.text()).slice(0, 32_000) : (await res.text()).slice(0, 8_000);

  const hdr = res.headers.get('payment-required') || res.headers.get('x-payment-required');
  add('status_is_402', res.status === 402, `HTTP ${res.status}`);
  add('challenge_header', Boolean(hdr), hdr ? 'PAYMENT-REQUIRED present' : 'absent');
  let ch = null;
  if (hdr) { try { ch = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8')); add('header_decodes', true, 'base64 JSON'); } catch { add('header_decodes', false, 'PAYMENT-REQUIRED is not base64 JSON'); } }
  if (!ch && body) { try { ch = JSON.parse(body); add('body_is_json', true, 'challenge read from the body'); } catch { add('body_is_json', false, body.slice(0, 120)); } }
  if (!ch || typeof ch !== 'object') { out.verdict = 'not_x402'; return out; }

  add('x402_version', ch.x402Version === 2 || ch.x402Version === 1, `x402Version ${ch.x402Version}`);
  const accepts = Array.isArray(ch.accepts) ? ch.accepts : [];
  add('accepts_present', accepts.length > 0, `${accepts.length} option(s)`);
  const a = accepts[0] || {};
  out.network = a.network || null;
  add('network_is_base', a.network === 'eip155:8453', a.network || 'missing');
  if (a.network && a.network !== 'eip155:8453') out.flags.push('network is not Base mainnet');
  add('asset_is_usdc', String(a.asset || '').toLowerCase() === CONFIG.usdc.toLowerCase(), a.asset || 'missing');
  if (a.asset && String(a.asset).toLowerCase() !== CONFIG.usdc.toLowerCase()) out.flags.push('asset is not Base USDC');
  add('pay_to_format', /^0x[0-9a-fA-F]{40}$/.test(String(a.payTo || '')), a.payTo || 'missing');
  const units = Number(a.amount);
  add('amount_numeric', Number.isFinite(units) && units >= 0, a.amount);
  if (Number.isFinite(units)) {
    out.price_usd = (units / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    if (units > 10_000_000) out.flags.push(`price is ${out.price_usd} USDC, above a usual per-call cap`);
    if (units === 0) out.flags.push('price is zero');
  }
  add('max_timeout_present', a.maxTimeoutSeconds !== undefined, a.maxTimeoutSeconds);
  if (a.maxTimeoutSeconds === undefined) out.flags.push('no maxTimeoutSeconds, a client cannot bound the signature');

  if (deep) {
    try {
      const w = await fetch(new URL('/.well-known/x402', u.origin), { headers: { accept: 'application/json', 'user-agent': CHECK_UA }, signal: AbortSignal.timeout(5000) });
      add('well_known_x402', w.ok, `HTTP ${w.status}`);
    } catch (e) { add('well_known_x402', false, e?.message || e); }
    const fac = (ch.facilitator || ch.accepts?.[0]?.extra?.facilitator || process.env.CHECK_FACILITATOR || CONFIG.facilitator);
    try {
      const s = await fetch(String(fac).replace(/\/$/, '') + '/supported', { headers: { accept: 'application/json', 'user-agent': CHECK_UA }, signal: AbortSignal.timeout(6000) });
      const sj = await s.json();
      const kinds = JSON.stringify(sj).includes('eip155:8453');
      add('facilitator_supports_network', s.ok && kinds, `${fac} HTTP ${s.status}`);
    } catch (e) { add('facilitator_supports_network', false, `${fac} ${e?.message || e}`); }
  }

  const failed = out.checks.filter((c) => !c.pass).map((c) => c.check);
  const core = ['status_is_402', 'accepts_present', 'pay_to_format', 'amount_numeric', 'network_is_base'];
  out.verdict = res.status !== 402 ? 'not_x402'
    : core.every((c) => out.checks.find((x) => x.check === c)?.pass) ? 'looks_payable'
    : 'suspicious';
  out.failed = failed;
  out.note = out.verdict === 'looks_payable'
    ? 'Challenge parses, payTo and amount are well formed, network is Base. This says nothing about whether the endpoint keeps its side of the deal.'
    : 'Something about this challenge does not add up. Read the checks before signing.';
  probeCache.set(u.host, { at: Date.now(), body: out });
  return out;
}

app.get('/api/x402-check', async (req, res) => {
  const target = String(req.query.url || '');
  if (!target) return res.status(400).json({ error: 'pass ?url=https://the-endpoint-you-are-about-to-pay' });
  if (!freeQuotaOk(req)) {
    return res.status(429).json({
      error: 'free quota used: 3 checks per day per IP',
      paid: `${PUBLIC_URL}/api/x402-deep-check?url=...`,
      price: '$0.01',
    });
  }
  res.json(await probeX402(target));
});

app.get('/pay-qr.svg', async (req, res) => {
  const svg = await QRCode.toString(CONFIG.payTo, { type: 'svg', margin: 1, color: { dark: '#F1F4F6', light: '#0000' } });
  res.type('image/svg+xml').send(svg);
});

// ---------------------------------------------------------------- static pages (explicit allowlist)
const PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/stats': 'index.html',
  '/agents.md': 'agents.md',
  '/llms.txt': 'llms.txt',
  '/robots.txt': 'robots.txt',
  '/sitemap.xml': 'sitemap.xml',
  '/openapi.json': 'openapi.json',
  '/.well-known/x402': 'x402.json',
  '/.well-known/agent-card.json': 'agent-card.json',
  '/.well-known/agent.json': 'agent-card.json',
};
app.get(Object.keys(PAGES), (req, res) => {
  const f = path.join(__dirname, 'public', PAGES[req.path]);
  if (!fs.existsSync(f)) return res.status(404).type('text/plain').send('not here\n');
  if (req.path.startsWith('/.well-known') || req.path.endsWith('.json')) res.type('application/json');
  else if (req.path.endsWith('.md')) res.type('text/markdown; charset=utf-8');
  else if (req.path.endsWith('.txt')) res.type('text/plain; charset=utf-8');
  else if (req.path.endsWith('.xml')) res.type('application/xml');
  res.sendFile(f);
});

app.use((req, res) => {
  res.status(404).json({ error: 'nothing here', see: ['/', '/agents.md', '/api/beg'], wallet: CONFIG.payTo });
});

app.listen(CONFIG.port, process.env.HOST || '10.0.0.1', () => {
  console.log(`[beggar] listening on ${process.env.HOST || '10.0.0.1'}:${CONFIG.port}  payTo=${CONFIG.payTo}  price=${CONFIG.price}  facilitator=${CONFIG.facilitator}`);
});

// ---------------------------------------------------------------- on-chain watcher: catches every dollar,
// including payments that never went through x402 (plain transfers straight to the wallet).
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const STATE = path.join(DATA, 'chain-state.json');

async function rpc(method, params, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(CONFIG.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function pollOnce() {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  let st = { lastBlock: 0 };
  if (fs.existsSync(STATE)) { try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {} }
  // first run: look back a few hours, not the whole chain. The wallet is empty until someone pays.
  if (!st.lastBlock) st.lastBlock = head - 5000;
  if (st.lastBlock > head) st.lastBlock = head - 100;
  let from = st.lastBlock + 1;
  while (from <= head) {
    const to = Math.min(from + 2000, head);
    let logs;
    try {
      logs = await rpc('eth_getLogs', [{
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        address: CONFIG.usdc,
        topics: [TRANSFER_TOPIC, null, '0x' + CONFIG.payTo.toLowerCase().replace(/^0x/, '').padStart(64, '0')],
      }]);
    } catch (e) {
      console.error(`[beggar] getLogs ${from}-${to} failed: ${e.message}; holding position`);
      return;
    }
    for (const l of logs) {
      const fromAddr = '0x' + l.topics[1].slice(26);
      const units = BigInt(l.data).toString();
      const rec = { ts: new Date().toISOString(), block: parseInt(l.blockNumber, 16), tx: l.transactionHash, from: fromAddr, amountUnits: units, amount: Number(units) / 1e6, logIndex: l.logIndex };
      append('onchain.jsonl', rec);
      console.log(`[beggar] USDC in: ${rec.amount} from ${fromAddr} tx ${rec.tx}`);
    }
    from = to + 1;
    st.lastBlock = to;
    fs.writeFileSync(STATE, JSON.stringify(st));
  }
}

const POLL_MS = Number(process.env.POLL_MS || 120000);
setInterval(() => pollOnce().catch((e) => console.error('[beggar] chain poll failed:', e.message)), POLL_MS);
pollOnce().catch((e) => console.error('[beggar] chain poll failed:', e.message));
