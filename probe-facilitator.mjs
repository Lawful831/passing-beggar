// Probe the public facilitators directly with a real (unfunded) EIP-3009 signature, to see
// exactly what they say about our payload. Diagnostics only.
import { ethers } from 'ethers';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0xcE2baA308C2e6f77833F126281884De1771D07e4';
const buyer = ethers.Wallet.createRandom();
const now = Math.floor(Date.now() / 1000);

const authorization = {
  from: buyer.address,
  to: PAY_TO,
  value: '1000000',
  validAfter: '0',
  validBefore: String(now + 600),
  nonce: ethers.hexlify(ethers.randomBytes(32)),
};
const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC };
const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
const signature = await buyer.signTypedData(domain, types, authorization);

const requirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000000',
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 600,
  extra: { name: 'USD Coin', version: '2' },
};

const shapes = {
  A: { x402Version: 2, paymentPayload: { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature, authorization } }, paymentRequirements: requirements },
  B: { x402Version: 2, paymentPayload: { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature, authorization }, accepted: requirements }, paymentRequirements: requirements },
  C: { x402Version: 2, paymentPayload: { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature, authorization } }, paymentRequirements: requirements, resource: 'http://94.72.112.144:4021/api/beg' },
};

const targets = [
  ['xpay.sh', 'https://facilitator.xpay.sh/verify'],
  ['arispay', 'https://facilitator.arispay.app/verify'],
  ['settlegrid', 'https://facilitator.settlegrid.ai/v1/verify'],
];

console.log('buyer:', buyer.address, 'nonce:', authorization.nonce);
for (const [name, url] of targets) {
  for (const [key, body] of Object.entries(shapes)) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const t = await r.text();
      console.log(`${name} shape ${key} -> ${r.status} ${t.slice(0, 300)}`);
    } catch (e) {
      console.log(`${name} shape ${key} -> ERROR ${e.message}`);
    }
  }
}
