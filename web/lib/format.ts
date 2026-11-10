export const usdc = (atomic: string | number | bigint | null | undefined) =>
  atomic === null || atomic === undefined ? "0.00" : (Number(atomic) / 1e6).toFixed(2);

export const short = (h: string | null | undefined, n = 6) => (h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : "-");

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Badge color + label for an escrow's state/reason. */
export function statusOf(state: string, reason: string, job?: string | null): { label: string; bg: string } {
  if (reason === "VerdictYes") return { label: "Paid · verified", bg: "bg-green" };
  if (reason === "VerdictNo") return { label: "Refunded · failed", bg: "bg-pink" };
  if (reason === "Equivocation") return { label: "Refunded · equivocation", bg: "bg-lavender" };
  if (reason === "DeadlineRefund") return { label: "Refunded · deadline", bg: "bg-orange" };
  if (reason === "ArbiterRelease") return { label: "Paid · arbiter", bg: "bg-green" };
  if (reason === "ArbiterRefund") return { label: "Refunded · arbiter", bg: "bg-pink" };
  if (state === "Escalated") return { label: "Escalated", bg: "bg-orange" };
  if (job === "judging") return { label: "Judging", bg: "bg-yellow" };
  return { label: "Held in escrow", bg: "bg-blue" };
}

export const sellerColor: Record<string, string> = {
  honest: "bg-green",
  lazy: "bg-orange",
  injector: "bg-pink",
  swapper: "bg-lavender",
};

export const sellerBlurb: Record<string, string> = {
  honest: "Five bullets, each a sentence from the source.",
  lazy: "Three bullets, one invented fact.",
  injector: "An invented fact plus a hidden note telling the judge to say yes.",
  swapper: "Serves junk, then commits a good answer as evidence.",
};
