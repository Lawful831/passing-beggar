#!/usr/bin/env node
// Push the beggar into the x402 directories that accept submissions without an account.
// Writes a log of every attempt to data/directory-submissions.json so nothing is claimed blindly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PUBLIC_URL || 'https://passing-beggar.94.72.112.144.sslip.io';
const ENDPOINT = `${BASE}/api/beg`;
const TASK = `${BASE}/api/task`;

const listing = {
  url: ENDPOINT,
  name: 'Passing Beggar',
  description:
    'A public HTTP 402 endpoint that asks passing AI agents for 1.00 USDC on Base. Paying is optional and stays optional. For the same dollar it also does a small task: a lookup, a short text, a translation, a summary, a small script, a review of a snippet. Queued and answered in public.',
  category: 'Other',
  tags: ['x402', 'usdc', 'base', 'micropayments', 'tips', 'tasks', 'agent-commerce'],
  contact: 'https://github.com/Lawful831',
  homepage: BASE,
  docs: `${BASE}/agents.md`,
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  price: '$1.00',
  priceUSDC: 1000000,
  payTo: '0xcE2baA308C2e6f77833F126281884De1771D07e4',
  endpoints: [
    { type: 'http', method: 'GET', url: ENDPOINT, description: 'One dollar, asked nicely. Returns a receipt.' },
    { type: 'http', method: 'POST', url: TASK, description: 'One dollar buys a small task. Body {"task":"..."}.' },
  ],
};

const TARGETS = [
  ['x402dash', 'https://api.x402dash.com/v1/register', listing],
  ['x402-list', 'https://x402-list.com/api/v1/submit', {
    type: 'service',
    name: listing.name,
    url: listing.url,
    base_url: BASE,
    description: listing.description,
    category: 'Other',
    tags: listing.tags,
    network: 'eip155:8453',
    asset: listing.asset,
    price: '1.00',
    priceUSD: 1,
    pay_to: listing.payTo,
    payTo: listing.payTo,
    contact: listing.contact,
    endpoints: listing.endpoints,
  }],
  ['agent-tools.cloud', 'https://agent-tools.cloud/api/v1/submit', {
    type: 'x402',
    url: listing.url,
    name: listing.name,
    description: listing.description,
    category: 'Other',
    tags: listing.tags,
    network: 'eip155:8453',
    asset: listing.asset,
    priceUSDC: listing.priceUSDC,
    payTo: listing.payTo,
    contact: listing.contact,
  }],
];

const results = [];
for (const [name, url, body] of TARGETS) {
  const rec = { name, url, at: new Date().toISOString(), request: body };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `${listing.name} registry submit (${listing.contact})` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    });
    rec.status = r.status;
    rec.response = (await r.text()).slice(0, 1500);
  } catch (e) {
    rec.error = e.message;
  }
  results.push(rec);
  console.log(`\n=== ${name} -> ${rec.status ?? 'ERROR'} ${rec.error || ''}`);
  console.log(rec.response || '');
}

const out = path.join(DIR, 'data', 'directory-submissions.jsonl');
fs.appendFileSync(out, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`\nlogged to ${out}`);
