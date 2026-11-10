// Independent verifier: re-checks a settle transaction from public data only (browser-safe).
// Decodes the settle calldata, recomputes hex(sha256(req)):hex(sha256(resp)) for every
// attestation, recovers the EIP-191 signer, checks SignerRegistry, and parses each verdict header.

import { decodeFunctionData, hexToBytes, recoverMessageAddress, type Address, type Hex, type PublicClient } from "viem";
import { escrowAbi, registryAbi } from "@assay/x402";
import { parseHeader } from "./header";

export interface CheckedAttestation {
  role: string;
  signedText: string;
  recovered: Address;
  provider: Address;
  registered: boolean;
  providerMatches: boolean;
  verdict: string;
  conf: number;
  rubricHash: Hex;
  evidenceHash: Hex;
  rationale: string;
  model?: string;
  requestId?: string;
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function verifySettleTx(client: PublicClient, registry: Address, hash: Hex) {
  const txn = await client.getTransaction({ hash });
  const { functionName, args } = decodeFunctionData({ abi: escrowAbi, data: txn.input });
  if (functionName !== "settle") throw new Error(`not a settle transaction: ${functionName}`);
  const [escrowId, judges, grounding, calibration, requestIds] = args as any;
  const all = [
    ...judges.map((j: any, i: number) => ({ role: `judge ${String.fromCharCode(65 + i)}`, ...j })),
    { role: "grounding", ...grounding },
    { role: "calibration", ...calibration },
  ];
  const out: CheckedAttestation[] = [];
  for (const [i, a] of all.entries()) {
    const req = hexToBytes(a.reqBody), resp = hexToBytes(a.respBody);
    const text = `${await sha256Hex(req)}:${await sha256Hex(resp)}`;
    const recovered = await recoverMessageAddress({ message: text, signature: a.signature });
    const [isSigner, providerOf] = await Promise.all([
      client.readContract({ address: registry, abi: registryAbi, functionName: "isSigner", args: [recovered] }),
      client.readContract({ address: registry, abi: registryAbi, functionName: "providerOf", args: [recovered] }),
    ]);
    const json = JSON.parse(new TextDecoder().decode(resp));
    const h = parseHeader(json.choices[0].message.content);
    out.push({
      role: a.role, signedText: text, recovered, provider: a.provider, registered: isSigner,
      providerMatches: providerOf.toLowerCase() === a.provider.toLowerCase(),
      verdict: h.verdict, conf: h.conf, rubricHash: h.rubricHash, evidenceHash: h.evidenceHash, rationale: h.rationale,
      model: json.model, requestId: requestIds[i],
    });
  }
  return { escrowId: escrowId as Hex, attestations: out, ok: out.every((a) => a.registered && a.providerMatches) };
}
