import type { Address, Hex } from "viem";

/** One TEE-attested model response: exactly what the contract receives. */
export interface Attested {
  reqBody: Uint8Array;   // exact bytes POSTed to {provider.url}/v1/proxy/chat/completions
  respBody: Uint8Array;  // exact bytes received back (the enclave hashes these)
  signature: Hex;        // EIP-191 signature over hex(sha256(req)) ":" hex(sha256(resp))
  signedText: string;    // the 129-char text the provider reports having signed
  provider: Address;     // 0G provider address
  signer: Address;       // enclave signer from InferenceServing.getService (effective)
  model: string;         // Service.model as registered on-chain
  content: string;       // the model's reply (header + rationale), for logs
  requestId: string;     // response `id`, logged in the Settled event
  chatId: string;        // ZG-Res-Key
}

export interface Policy {
  judges: number;
  minAgree: number;
  minConfBps: number;
  requireGrounded: boolean;
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
