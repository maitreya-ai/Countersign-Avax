// Funds the 0G ledger and provider sub-accounts for Direct mode.
//   bun run src/fund.ts            (ledger: 3 0G minimum; 1 0G per pipeline provider)
// transferFund also acknowledges the provider's TEE signer on-chain for this account.

import { ethers } from "ethers";
import { PIPELINE_MODELS } from "./judges";
import { broker, pickProvider, zgWallet } from "./zg";

// Testnet 0G is scarce: ZG_SUB_FUND lowers the per-provider transfer (default 1 0G).
const SUB = process.env.ZG_SUB_FUND ?? "1";
const w = zgWallet();
const bal = await w.provider!.getBalance(w.address);
console.log(`0G wallet ${w.address}  balance ${ethers.formatEther(bal)} 0G`);

const b = await broker();
let ledgerOk = true;
try { await b.ledger.getLedger(); } catch { ledgerOk = false; }
if (!ledgerOk) {
  // The SDK refuses < 3 0G client-side, but the binding rule is LedgerManager.MIN_ACCOUNT_BALANCE
  // (0.1 0G on Galileo). ZG_LEDGER_FUND below 3 goes straight to the contract.
  const LEDGER = process.env.ZG_LEDGER_FUND ?? "3";
  console.log(`creating ledger with ${LEDGER} 0G ...`);
  if (Number(LEDGER) >= 3) await b.ledger.depositFund(Number(LEDGER));
  else await (b.ledger as any).ledger.ledgerContract.depositFund(ethers.parseEther(LEDGER).toString());
}
for (const m of PIPELINE_MODELS) {
  const p = await pickProvider(m);
  let existing: bigint | undefined;
  try { existing = BigInt((await b.inference.getAccount(p)).balance); } catch { /* no sub-account yet */ }
  if (existing !== undefined && existing > 0n && process.env.ZG_FORCE_FUND !== "1") {
    console.log(`sub-account for ${m} (${p}) already holds ${ethers.formatEther(existing)} 0G, skipping (ZG_FORCE_FUND=1 to top up)`);
    continue;
  }
  console.log(`transfer ${SUB} 0G to sub-account for ${m} (${p}) ...`);
  await b.ledger.transferFund(p, "inference", ethers.parseEther(SUB));
}
console.log("done");
