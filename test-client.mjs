// Real x402 client, using the official SDK, against the local beggar.
// Uses a fresh unfunded wallet: the expected outcome is a 402 with the facilitator's
// "insufficient funds" reason, which proves the whole loop is wired and only money is missing.
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { generatePrivateKey } from 'viem/accounts';

const TARGET = process.env.TARGET || 'http://127.0.0.1:4021/api/beg';
const pk = process.env.PK || generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log('client wallet  :', account.address, '(unfunded, on purpose)');

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }],
});

const res = await fetchWithPayment(TARGET, { headers: { accept: 'application/json' } });
const text = await res.text();
console.log('status         :', res.status);
console.log('body           :', text.slice(0, 800));
console.log('payment resp hdr:', (res.headers.get('payment-response') || 'none').slice(0, 300));
