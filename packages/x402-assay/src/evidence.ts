// Evidence format `assay-evidence-v1`: the exact bytes the judges see and the seller signs.
//
//   ASSAY-EVIDENCE v1
//   REQUEST <METHOD> <PATH>
//   <request body, verbatim>
//
//   RESPONSE <STATUS>
//   <response body, verbatim>
//
// UTF-8, LF line endings, no trailing newline. PATH has no host or query. evidenceHash = keccak256(bytes).

import { keccak256, toBytes, type Hex } from "viem";

export interface EvidenceInput {
  method: string;
  path: string;
  requestBody: Uint8Array | string;
  status: number;
  responseBody: Uint8Array | string;
}

const strict = new TextDecoder("utf-8", { fatal: true });

function text(b: Uint8Array | string, what: string): string {
  if (typeof b === "string") return b;
  try {
    return strict.decode(b);
  } catch {
    throw new Error(`${what} is not valid UTF-8`);
  }
}

export function buildEvidence(e: EvidenceInput): { text: string; hash: Hex } {
  const path = e.path.split("?")[0]!;
  const t = `ASSAY-EVIDENCE v1\nREQUEST ${e.method.toUpperCase()} ${path}\n${text(e.requestBody, "request body")}\n\nRESPONSE ${e.status}\n${text(e.responseBody, "response body")}`;
  return { text: t, hash: evidenceHashOf(t) };
}

export function evidenceHashOf(evidence: string): Hex {
  return keccak256(toBytes(evidence));
}

/** Truncate to at most `max` UTF-8 bytes without splitting a character. */
export function truncateUtf8(b: Uint8Array, max: number): Uint8Array {
  if (b.length <= max) return b;
  let end = max;
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  return b.slice(0, end);
}
