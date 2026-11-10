// x402 "exact" scheme on Arc, settled locally: the payer signs an EIP-3009
// TransferWithAuthorization for Arc USDC (domain name "USDC", version "2"; checked against the
// token's DOMAIN_SEPARATOR); the server verifies it and submits transferWithAuthorization
// itself, paying gas. No facilitator account needed. Used by api.ts when CIRCLE_API_KEY is unset.

import { parseAbi, parseSignature, verifyTypedData, type Address, type Hex } from "viem";
import { arcTestnet, publicClient, USDC, wallet } from "./arc";

const ARC_CHAIN_ID = arcTestnet.id;

export const usdcDomain = { name: "USDC", version: "2", chainId: ARC_CHAIN_ID, verifyingContract: USDC } as const;

export const authTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const usdcAbi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

export interface Authorization { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex }
export interface PaymentPayload { x402Version: number; accepted?: unknown; payload: { signature: Hex; authorization: Authorization } }
export interface Requirements { amount: string; payTo: Address; maxTimeoutSeconds: number }

/** Same checks a facilitator's /verify makes; returns a reason when invalid. */
export async function verifyPayment(p: PaymentPayload, req: Requirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: Address }> {
  const a = p?.payload?.authorization;
  const sig = p?.payload?.signature;
  if (!a || !sig) return { isValid: false, invalidReason: "missing authorization or signature" };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { isValid: false, invalidReason: "wrong payTo" };
  if (BigInt(a.value) < BigInt(req.amount)) return { isValid: false, invalidReason: "amount below price" };
  if (BigInt(a.validAfter) > now) return { isValid: false, invalidReason: "not yet valid" };
  if (BigInt(a.validBefore) <= now + 6n) return { isValid: false, invalidReason: "expired" };
  const message = { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce };
  const ok = await verifyTypedData({ address: a.from, domain: usdcDomain, types: authTypes, primaryType: "TransferWithAuthorization", message, signature: sig });
  if (!ok) return { isValid: false, invalidReason: "bad signature" };
  const used = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "authorizationState", args: [a.from, a.nonce] });
  if (used) return { isValid: false, invalidReason: "nonce already used" };
  const bal = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [a.from] });
  if (bal < BigInt(a.value)) return { isValid: false, invalidReason: "insufficient balance" };
  return { isValid: true, payer: a.from };
}

/** Submit the authorization on Arc; the server's wallet pays gas. */
export async function settlePayment(p: PaymentPayload): Promise<{ success: boolean; transaction: Hex; network: string; payer: Address }> {
  const a = p.payload.authorization;
  const { v, r, s, yParity } = parseSignature(p.payload.signature);
  const { client, account } = wallet();
  const hash = await client.writeContract({
    account, address: USDC, abi: usdcAbi, functionName: "transferWithAuthorization",
    args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? BigInt(27 + yParity!)), r, s],
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  return { success: rcpt.status === "success", transaction: hash, network: `eip155:${ARC_CHAIN_ID}`, payer: a.from };
}
