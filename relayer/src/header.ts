// The signed verdict text begins with a fixed-width ASCII header that the
// CountersignOracle contract parses by byte offset (no JSON on-chain).
//
//   VERDICT:Y;CONF:0.93;RUBRIC:0x<64 hex>;EVID:0x<64 hex>;<rationale>
//   ^0      ^8 ^10   ^15  ^20     ^27      ^93  ^99        ^165
//
// Offsets must match CountersignOracle.sol exactly.

import type { Hex } from "viem";

export const HEADER_LEN = 166;
export type VerdictChar = "Y" | "N" | "U";

export interface Header {
  verdict: VerdictChar;
  conf: number; // 0..1, two decimals
  rubricHash: Hex;
  evidenceHash: Hex;
}

export function buildHeader(h: Header): string {
  if (h.conf < 0 || h.conf > 1) throw new Error("conf out of range");
  const conf = h.conf.toFixed(2); // "0.93" / "1.00", always 4 chars
  const r = h.rubricHash.toLowerCase();
  const e = h.evidenceHash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(r) || !/^0x[0-9a-f]{64}$/.test(e)) throw new Error("bad hash");
  const s = `VERDICT:${h.verdict};CONF:${conf};RUBRIC:${r};EVID:${e};`;
  if (s.length !== HEADER_LEN) throw new Error(`header length ${s.length} != ${HEADER_LEN}`);
  return s;
}

const RE = /^VERDICT:([YNU]);CONF:(\d\.\d\d);RUBRIC:(0x[0-9a-fA-F]{64});EVID:(0x[0-9a-fA-F]{64});/;

export function parseHeader(text: string): Header & { rationale: string } {
  const m = RE.exec(text);
  if (!m) throw new Error(`malformed header: ${JSON.stringify(text.slice(0, HEADER_LEN))}`);
  return {
    verdict: m[1] as VerdictChar,
    conf: Number(m[2]),
    rubricHash: m[3].toLowerCase() as Hex,
    evidenceHash: m[4].toLowerCase() as Hex,
    rationale: text.slice(HEADER_LEN),
  };
}

export function confToBps(conf: number): number {
  return Math.round(conf * 10000);
}
