// EIP-712 payloads: USDC EIP-3009 authorisations and CountersignEscrow receipts.

import { parseSignature, verifyTypedData, type Account, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import type { Authorization } from "./types";

export function usdcDomain(chainId: number, asset: Address, name = "USD Coin", version = "2") {
  return { name, version, chainId, verifyingContract: asset } as const;
}

const authFields = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export const receiveTypes = { ReceiveWithAuthorization: authFields } as const;
export const transferTypes = { TransferWithAuthorization: authFields } as const;

export function authMessage(a: Authorization) {
  return {
    from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore), nonce: a.nonce,
  };
}

type Signer = LocalAccount | { wallet: WalletClient; account: Account | Address };

async function signTyped(signer: Signer, args: any): Promise<Hex> {
  if ("wallet" in signer) return signer.wallet.signTypedData({ account: signer.account, ...args } as any);
  return signer.signTypedData(args);
}

/** Buyer: sign ReceiveWithAuthorization (countersign scheme; `to` is the escrow, nonce is the terms hash). */
export function signReceiveAuthorization(signer: Signer, domain: ReturnType<typeof usdcDomain>, a: Authorization) {
  return signTyped(signer, { domain, types: receiveTypes, primaryType: "ReceiveWithAuthorization", message: authMessage(a) });
}

/** Buyer: sign TransferWithAuthorization (x402 `exact`). */
export function signTransferAuthorization(signer: Signer, domain: ReturnType<typeof usdcDomain>, a: Authorization) {
  return signTyped(signer, { domain, types: transferTypes, primaryType: "TransferWithAuthorization", message: authMessage(a) });
}

export function verifyAuthorization(kind: "receive" | "transfer", domain: ReturnType<typeof usdcDomain>, a: Authorization, signature: Hex) {
  return kind === "receive"
    ? verifyTypedData({ address: a.from, domain, types: receiveTypes, primaryType: "ReceiveWithAuthorization", message: authMessage(a), signature })
    : verifyTypedData({ address: a.from, domain, types: transferTypes, primaryType: "TransferWithAuthorization", message: authMessage(a), signature });
}

export function splitSig(signature: Hex) {
  const { v, r, s, yParity } = parseSignature(signature);
  return { v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s };
}

// ---- receipts ------------------------------------------------------------------

export function receiptDomain(chainId: number, escrow: Address) {
  return { name: "CountersignEscrow", version: "1", chainId, verifyingContract: escrow } as const;
}

export const receiptTypes = {
  Receipt: [
    { name: "escrowId", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
  ],
} as const;

/** Seller: sign the receipt for the evidence it served under `escrowId`. */
export function signReceipt(signer: Signer, chainId: number, escrow: Address, escrowId: Hex, evidenceHash: Hex) {
  return signTyped(signer, { domain: receiptDomain(chainId, escrow), types: receiptTypes, primaryType: "Receipt", message: { escrowId, evidenceHash } });
}

/** Verify a receipt. With a public client, ERC-1271 seller wallets also verify (as the contract does). */
export async function verifyReceipt(
  payee: Address, chainId: number, escrow: Address, escrowId: Hex, evidenceHash: Hex, signature: Hex, client?: PublicClient,
): Promise<boolean> {
  const args = { address: payee, domain: receiptDomain(chainId, escrow), types: receiptTypes, primaryType: "Receipt", message: { escrowId, evidenceHash }, signature } as const;
  try {
    return client ? await client.verifyTypedData(args) : await verifyTypedData(args);
  } catch {
    return false;
  }
}
