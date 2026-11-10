// The demo story: an agent buys the same summary from four sellers over x402 `countersign`, the judges
// decide, the contract pays or refunds, and the agent picks its next seller by verified record.
//
//   bun run demo/agent/buy.ts                 # all four sellers
//   bun run demo/agent/buy.ts --only honest   # one seller

import { account, fmtUsdc, publicClient, txUrl } from "@countersign/core";
import { usdcAbi, type Purchase } from "@countersign/x402";
import { buyFrom, inspectSeller, SELLER_NAMES } from "./src/lib";

const SELLERS = (process.env.SELLERS_URL ?? "http://localhost:8403").replace(/\/$/, "");
const NODE = (process.env.NODE_URL ?? "http://localhost:8402").replace(/\/$/, "");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]!.split(",") : [...SELLER_NAMES];
const agent = account("AGENT_PRIVATE_KEY");
const usdc = process.env.USDC as `0x${string}`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const color = (ok: boolean, s: string) => `\x1b[${ok ? 32 : 31}m${s}\x1b[0m`;

const balance = () => publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [agent.address] });

console.log(bold(`\nCountersign demo agent ${agent.address}`));
const start = await balance();
console.log(`USDC balance ${fmtUsdc(start)}   (the agent holds no AVAX: every purchase is one gasless signature)\n`);

console.log(bold("1. Verified records before buying (ERC-8004 Validation Registry, Fuji)"));
for (const name of only) {
  const s = await inspectSeller(SELLERS, name, publicClient);
  const t = s.trust;
  console.log(`  ${name.padEnd(9)} agent ${String(t?.agentId ?? "-").padEnd(6)} ${t ? `${t.count} judged sales, avg ${t.avg}/100` : "no record"}${t?.selfFiling ? "" : dim("  (seller has not approved self-filing)")}`);
}

console.log(bold("\n2. Buying a 5-bullet summary from each seller (scheme: countersign)"));
const purchases: { name: string; p: Purchase }[] = [];
for (const name of only) {
  const p = await buyFrom(SELLERS, name, { account: agent, publicClient, log: (m) => console.log(dim(`    [${name}] ${m}`)) });
  const bullets = (() => { try { return JSON.parse(new TextDecoder().decode(p.body)).bullets as string[]; } catch { return []; } })();
  console.log(`  ${bold(name)}: HTTP ${p.response.status}, ${bullets.length} bullets, escrow ${p.escrowId?.slice(0, 18)}…`);
  if (p.payment?.transaction) console.log(dim(`    open  ${txUrl(p.payment.transaction)}`));
  purchases.push({ name, p });
}

console.log(bold("\n3. Judges decide; the contract verifies their signatures and moves the money"));
await Promise.all(purchases.map(async ({ name, p }) => {
  const f = await p.watch({ intervalMs: 2500 });
  const paid = f.reason === "VerdictYes";
  const detail = await fetch(`${NODE}/escrows/${p.escrowId}`).then((r) => r.json()).catch(() => ({})) as any;
  console.log(`  ${name.padEnd(9)} ${color(paid, `${f.state} / ${f.reason}`)}${f.equivocationReported ? "  (seller committed evidence it never served)" : ""}`);
  if (detail?.tx?.settle) console.log(dim(`    settle ${txUrl(detail.tx.settle)}`));
  if (detail?.tx?.final) console.log(dim(`    final  ${txUrl(detail.tx.final)}`));
}));

console.log(bold("\n4. Outcomes written to each seller's ERC-8004 record"));
await new Promise((r) => setTimeout(r, 4000));
const after: { name: string; avg: number; count: number }[] = [];
for (const { name, p } of purchases) {
  let d: any = {};
  for (let i = 0; i < 20 && !d?.tx?.record; i++) {
    d = await fetch(`${NODE}/escrows/${p.escrowId}`).then((r) => r.json()).catch(() => ({}));
    if (!d?.tx?.record) await new Promise((r) => setTimeout(r, 2000));
  }
  const s = await inspectSeller(SELLERS, name, publicClient);
  after.push({ name, avg: s.trust?.avg ?? 0, count: s.trust?.count ?? 0 });
  console.log(`  ${name.padEnd(9)} score ${String(d?.score ?? "-").padEnd(4)} record now ${s.trust?.count ?? 0} sales, avg ${s.trust?.avg ?? 0}/100${d?.tx?.record ? dim(`  ${txUrl(d.tx.record)}`) : ""}`);
}

const end = await balance();
console.log(`\nUSDC ${fmtUsdc(start)} -> ${fmtUsdc(end)}  (paid only for work that passed)`);
const best = after.filter((s) => s.count > 0).sort((a, b) => b.avg - a.avg || b.count - a.count)[0];
if (best) console.log(bold(`Next time: buy from ${best.name} (verified ${best.avg}/100 over ${best.count} sales).\n`));
