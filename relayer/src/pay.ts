// x402 client: an agent buys one verdict from api.ts and pays in Arc USDC.
//   bun run src/pay.ts [http://localhost:8402]      (payer key: PAYEE_PRIVATE_KEY, or PAYER_ENV)
// 1. POST /verdict unpaid -> 402 with PAYMENT-REQUIRED
// 2. sign an EIP-3009 TransferWithAuthorization for the quoted amount
// 3. POST again with PAYMENT-SIGNATURE -> 200 bundle + PAYMENT-RESPONSE (the settle tx)

import { toHex, type Address } from "viem";
import { erc20Abi, publicClient, tx, USDC, wallet } from "./arc";
import { authTypes, usdcDomain } from "./x402";

const base = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 8402}`;
const payer = wallet(process.env.PAYER_ENV ?? "PAYEE_PRIVATE_KEY");
const body = JSON.stringify({
  rubric: "Pass only if the evidence contains a github.com repository URL.",
  evidence: "Repository: https://github.com/verdict-oracle/landing",
});

const r1 = await fetch(`${base}/verdict`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
console.log(`1. unpaid POST -> HTTP ${r1.status}`);
if (r1.status !== 402) throw new Error(await r1.text());
const required = JSON.parse(atob(r1.headers.get("PAYMENT-REQUIRED")!));
const req = required.accepts[0];
console.log(`   quote: ${Number(req.amount) / 1e6} USDC to ${req.payTo} on ${req.network}`);

const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: payer.account.address, to: req.payTo as Address, value: req.amount,
  validAfter: String(now - 60), validBefore: String(now + req.maxTimeoutSeconds),
  nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
};
const signature = await payer.account.signTypedData({
  domain: usdcDomain, types: authTypes, primaryType: "TransferWithAuthorization",
  message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
});
const header = btoa(JSON.stringify({ x402Version: 2, accepted: req, payload: { signature, authorization } }));
console.log(`2. signed EIP-3009 authorization from ${payer.account.address}`);

const before = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [payer.account.address] });
const r2 = await fetch(`${base}/verdict`, { method: "POST", headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": header }, body });
const j: any = await r2.json();
console.log(`3. paid POST -> HTTP ${r2.status}`);
if (!r2.ok) throw new Error(JSON.stringify(j).slice(0, 500));
const settled = JSON.parse(atob(r2.headers.get("PAYMENT-RESPONSE")!));
const after = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [payer.account.address] });
console.log(`   payment settled: ${tx(settled.transaction)}`);
console.log(`   payer USDC ${before} -> ${after}`);
console.log(`   ${j.attestations.length} attestations, request ids ${j.requestIds.join(", ")}`);
console.log(`   settleCalldata ${j.settleCalldata.length / 2 - 1} bytes (swap in your escrow id)`);
