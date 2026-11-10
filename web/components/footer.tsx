import { CONFIG } from "@/lib/config";
import { AddressLink } from "./hash";
import { Logo } from "./nav";

export function Footer() {
  const c = CONFIG.contracts;
  const rows: [string, string | null | undefined][] = [
    ["CountersignEscrow", c?.escrow],
    ["CountersignOracle", c?.oracle],
    ["SignerRegistry", c?.signerRegistry],
    ["CountersignValidator", c?.validator],
    ["ERC-8004 Identity", c?.identityRegistry],
    ["ERC-8004 Validation", c?.validationRegistry],
    ["USDC (Circle)", c?.usdc],
  ];
  return (
    <footer className="mt-24 border-t-[3px] border-black bg-black text-paper">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.2fr_2fr]">
        <div>
          <div className="inline-block bg-paper p-2 text-black"><Logo /></div>
          <p className="mt-4 max-w-sm text-sm text-paper/80">
            Verified outcomes for agent payments on Avalanche. x402 payments settle only when signed LLM judges confirm the
            seller kept its promise, and every verdict becomes a portable ERC-8004 record.
          </p>
          <p className="mt-4 max-w-sm text-xs text-paper/60">
            Built by Maitreya.
          </p>
        </div>
        <div>
          <div className="font-mono text-xs font-bold uppercase tracking-wider text-yellow">
            Contracts · {CONFIG.chainId === 43113 ? "Avalanche Fuji" : CONFIG.chainId === 43114 ? "Avalanche C-Chain" : `chain ${CONFIG.chainId}`}
          </div>
          <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 border-b border-paper/20 py-1.5">
                <dt className="text-sm text-paper/80">{k}</dt>
                <dd className="[&_a]:text-paper"><AddressLink address={v ?? null} /></dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </footer>
  );
}
