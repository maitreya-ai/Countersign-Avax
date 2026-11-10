import type { Address, Hex } from "viem";

/** One signed model response: exactly what the oracle receives. */
export interface Attested {
  reqBody: Uint8Array;   // exact bytes POSTed to the model API
  respBody: Uint8Array;  // exact bytes received back
  signature: Hex;        // EIP-191 signature over hex(sha256(req)) ":" hex(sha256(resp))
  signedText: string;    // the 129-char text that was signed
  provider: Address;     // provider id (self-attested: the signer itself)
  signer: Address;
  model: string;
  content: string;       // the model's reply (header + rationale)
  requestId: string;     // response `id`, logged in the Settled event
}

export interface Bundle {
  judges: Attested[];
  grounding: Attested;
  calibration: Attested;
}

export interface Case {
  rubric: string;
  evidence: string;
  rubricHash: Hex;
  evidenceHash: Hex;
}
