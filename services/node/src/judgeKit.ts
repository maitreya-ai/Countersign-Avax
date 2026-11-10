// Judge pipeline wiring for the node: make sure every self-attested judge key is in SignerRegistry.

import { zeroHash, type Address } from "viem";
import { registryAbi } from "@countersign/x402";
import { PIPELINE_MODELS, buildBundle, publicClient, selfAccount, settleArgs, toAttestedArg, type Bundle } from "@countersign/core";
import { cfg, send } from "./ctx";

const known = new Set<string>();

export async function registerSigner(signer: Address, model: string) {
  const key = signer.toLowerCase();
  if (known.has(key)) return;
  const [active, provider] = await Promise.all([
    publicClient.readContract({ address: cfg.registry, abi: registryAbi, functionName: "isSigner", args: [signer] }),
    publicClient.readContract({ address: cfg.registry, abi: registryAbi, functionName: "providerOf", args: [signer] }),
  ]);
  if (!active || provider.toLowerCase() !== key) {
    const { hash } = await send({ address: cfg.registry, abi: registryAbi as any, functionName: "sync", args: [signer, signer, model, 0n, zeroHash] });
    console.log(`[judges] registered ${model} signer ${signer} ${hash}`);
  }
  known.add(key);
}

export async function registerSignersFor(b: Bundle) {
  for (const a of [...b.judges, b.grounding, b.calibration]) await registerSigner(a.signer, a.model);
}

/** Register the configured pipeline's signers at startup (idempotent). */
export async function ensurePipelineSigners() {
  for (const m of PIPELINE_MODELS) await registerSigner(selfAccount(m).address, m);
}

export { buildBundle, publicClient, settleArgs, toAttestedArg, type Bundle };
