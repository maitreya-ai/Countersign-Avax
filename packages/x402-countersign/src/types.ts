import type { Address, Hex } from "viem";

/** x402 scheme id for payments held in CountersignEscrow until verified LLM judges decide. */
export const SCHEME = "countersign" as const;
export const EVIDENCE_FORMAT = "countersign-evidence-v1" as const;
export const VALIDATION_TAG_STRING = "countersign" as const;

export interface Policy {
  judges: number;          // judge attestations required (distinct models)
  minAgree: number;        // judges that must share the first judge's verdict
  minConfBps: number;      // calibration confidence floor, basis points
  requireGrounded: boolean;
}

/** `extra` of an `countersign` PaymentRequirements entry. */
export interface CountersignExtra {
  name: string;            // USDC EIP-712 domain name ("USD Coin" on Avalanche)
  version: string;         // USDC EIP-712 domain version ("2")
  escrow: Address;
  rubric: string;          // the seller's promise, judged verbatim
  policy: Policy;
  deadlineSeconds: number; // escrow deadline = signing time + this
  arbiter: Address;        // 0x0 = none (escalations end in a deadline refund)
  agentId: string | null;  // seller's ERC-8004 agent id (decimal string), signed into the terms
  validator?: Address;     // CountersignValidator writing the seller's ERC-8004 record
  identityRegistry?: Address;
  validationRegistry?: Address;
  facilitator?: string;    // countersign node: opens escrows, accepts evidence, judges, settles
  evidence: { format: typeof EVIDENCE_FORMAT; maxRequestBytes: number; maxResponseBytes: number };
}

export interface PaymentRequirements<E = any> {
  scheme: string;
  network: string;         // CAIP-2, e.g. "eip155:43113"
  asset: Address;
  amount: string;          // atomic units
  payTo: Address;
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
  mimeType: string;
  extra: E;
}

export interface PaymentRequired {
  x402Version: 2;
  accepts: PaymentRequirements[];
  error?: string;
}

/** EIP-3009 authorisation fields (decimal strings, as x402 sends them). */
export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface ExactPayload {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: { signature: Hex; authorization: Authorization };
}

export interface CountersignPayload {
  x402Version: 2;
  accepted: PaymentRequirements<CountersignExtra>;
  payload: {
    signature: Hex;        // EIP-712 ReceiveWithAuthorization, to = escrow, nonce = termsHash
    authorization: Authorization;
    salt: Hex;
    deadline: string;      // unix seconds
  };
}

export type PaymentPayload = ExactPayload | CountersignPayload;

/** Seller-signed receipt for what it served (header X-COUNTERSIGN-RECEIPT, base64 JSON). */
export interface CountersignReceipt {
  escrowId: Hex;
  evidenceHash: Hex;
  signature: Hex;
  format: typeof EVIDENCE_FORMAT;
}

/** PAYMENT-RESPONSE header body. */
export interface SettleResponse {
  success: boolean;
  transaction?: Hex;
  network: string;
  payer?: Address;
  escrowId?: Hex;
  errorReason?: string;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: Address;
}

export enum EscrowState { None, Open, Resolved, Refunded, Escalated }
export enum EscrowReason { None, VerdictYes, VerdictNo, ArbiterRelease, ArbiterRefund, DeadlineRefund, Equivocation }

export const STATE_NAMES = ["None", "Open", "Resolved", "Refunded", "Escalated"] as const;
export const REASON_NAMES = ["None", "VerdictYes", "VerdictNo", "ArbiterRelease", "ArbiterRefund", "DeadlineRefund", "Equivocation"] as const;

export interface EscrowView {
  payer: Address;
  payee: Address;
  arbiter: Address;
  amount: bigint;
  deadline: bigint;
  rubricHash: Hex;
  evidenceHash: Hex;
  policy: Policy;
  state: number;
  reason: number;
  agentId: bigint;
}
