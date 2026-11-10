// Off-chain mirrors of AssayEscrow.termsHash / escrowIdFor and AssayValidator.requestHashFor.
// Parity with the contracts is tested against a local chain (test/parity.test.ts).

import { encodeAbiParameters, keccak256, maxUint256, toHex, type Address, type Hex } from "viem";
import type { Policy } from "./types";

export const TERMS_TAG = keccak256(toHex("assay.terms.v1"));
export const VALIDATION_TAG = keccak256(toHex("assay.validation.v1"));
export const NO_AGENT = maxUint256;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const policyTuple = {
  type: "tuple",
  components: [
    { name: "judges", type: "uint8" },
    { name: "minAgree", type: "uint8" },
    { name: "minConfBps", type: "uint16" },
    { name: "requireGrounded", type: "bool" },
  ],
} as const;

export interface Terms {
  chainId: number;
  escrow: Address;
  payee: Address;
  arbiter: Address;
  amount: bigint;
  deadline: bigint;
  rubricHash: Hex;
  policy: Policy;
  agentId: bigint;        // NO_AGENT when the seller has no ERC-8004 identity
  salt: Hex;
}

export function rubricHashOf(rubric: string): Hex {
  return keccak256(toHex(rubric));
}

/** keccak256(abi.encode(TERMS_TAG, chainid, escrow, payee, arbiter, amount, deadline, rubricHash, policy, agentId, salt)) */
export function termsHash(t: Terms): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" },
        { type: "uint96" }, { type: "uint64" }, { type: "bytes32" }, policyTuple, { type: "uint256" }, { type: "bytes32" },
      ],
      [
        TERMS_TAG, BigInt(t.chainId), t.escrow, t.payee, t.arbiter, t.amount, t.deadline, t.rubricHash,
        { ...t.policy }, t.agentId, t.salt,
      ],
    ),
  );
}

export function escrowIdFor(payer: Address, termsNonce: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [payer, termsNonce]));
}

export function requestHashFor(escrowId: Hex, agentId: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [VALIDATION_TAG, escrowId, agentId]));
}

export function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function parseAgentId(id: string | null | undefined): bigint {
  return id === null || id === undefined || id === "" ? NO_AGENT : BigInt(id);
}
