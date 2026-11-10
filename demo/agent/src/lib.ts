// Demo buyer agent: buys a 5-bullet summary over x402 `assay` from one of the demo sellers.

import { readFileSync } from "node:fs";
import type { LocalAccount, PublicClient } from "viem";
import { fetchWithAssay, getOffer, sellerTrust, type Purchase, type SellerTrust } from "@assay/x402";

export const ARTICLE = readFileSync(new URL("../fixtures/article.txt", import.meta.url), "utf8");
export const SELLER_NAMES = ["honest", "lazy", "injector", "swapper"] as const;
export type SellerName = (typeof SELLER_NAMES)[number];

/** The exact request body bytes (they become part of the evidence). */
export function summarizeBody(): string {
  return JSON.stringify({ document: ARTICLE, bullets: 5 });
}

export function sellerUrl(base: string, name: string) {
  return `${base.replace(/\/$/, "")}/${name}/summarize`;
}

export async function inspectSeller(base: string, name: string, client: PublicClient): Promise<{ trust: SellerTrust | null; price: string; rubric: string }> {
  const offer = await getOffer(sellerUrl(base, name), { method: "POST", headers: { "Content-Type": "application/json" }, body: summarizeBody() });
  if (!offer.assay) throw new Error(`${name} does not offer the assay scheme`);
  return { trust: await sellerTrust(client, offer.assay).catch(() => null), price: offer.assay.amount, rubric: offer.assay.extra.rubric };
}

export async function buyFrom(
  base: string,
  name: string,
  opts: { account: LocalAccount; publicClient: PublicClient; maxAmount?: bigint; log?: (m: string) => void },
): Promise<Purchase> {
  return fetchWithAssay(
    sellerUrl(base, name),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: summarizeBody() },
    {
      account: opts.account, publicClient: opts.publicClient, prefer: "assay", maxAmount: opts.maxAmount ?? 1_000_000n,
      minTrust: { minCount: 1_000_000, minAvg: 0 }, // read the record, never refuse (the demo compares sellers itself)
      log: opts.log,
    },
  );
}
