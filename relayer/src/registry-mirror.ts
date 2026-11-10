// Registry mirror: copies 0G InferenceServing Service records (provider -> enclave signer)
// into SignerRegistry on Arc, recording the 0G block they were read at.
//   bun run src/registry-mirror.ts <provider> [<provider> ...]
// With no arguments, mirrors the TeeML provider pickProvider finds for each pipeline model
// (router on mainnet, InferenceServing on testnet; no key needed). Self-attested models
// (groq:/gemini:) register their derived signer instead.

import { zeroHash, type Address } from "viem";
import { addr, publicClient, registryAbi, tx, wallet } from "./arc";
import { PIPELINE_MODELS } from "./judges";
import { isSelfModel, selfAccount } from "./selfsign";
import { getService, pickProvider } from "./zg";

/** Write signer -> (provider, model) into SignerRegistry unless it is already there. */
export async function registerSigner(provider: Address, signer: Address, model: string, block: bigint, log = console.log) {
  const { account, client } = wallet();
  const registry = addr("SIGNER_REGISTRY");
  const already = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: "providerOf", args: [signer] });
  if (already.toLowerCase() === provider.toLowerCase()) {
    log(`  ${model}: signer ${signer} already mirrored`);
    return;
  }
  const hash = await client.writeContract({
    address: registry, abi: registryAbi, functionName: "sync",
    args: [provider, signer, model, block, zeroHash], account,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`  ${model}: provider ${provider} -> signer ${signer} @0G block ${block}  ${tx(hash)}`);
}

export async function mirrorProvider(provider: Address, log = console.log) {
  const svc = await getService(provider);
  if (svc.verifiability !== "TeeML") throw new Error(`${provider} is ${svc.verifiability}; only TeeML signers are mirrored`);
  await registerSigner(provider, svc.signer, svc.model, svc.block, log);
  return svc;
}

if (import.meta.main) {
  let providers = process.argv.slice(2) as Address[];
  if (providers.length === 0) {
    for (const m of PIPELINE_MODELS.filter(isSelfModel)) {
      const a = selfAccount(m); // self-attested: our derived key, no 0G read (block 0)
      await registerSigner(a.address, a.address, m, 0n);
    }
    const found = await Promise.all(PIPELINE_MODELS.filter((m) => !isSelfModel(m)).map(async (m) => [m, await pickProvider(m)] as const));
    for (const [m, p] of found) console.log(`  ${m} -> ${p}`);
    providers = [...new Set(found.map(([, p]) => p))];
  }
  console.log("mirroring into SignerRegistry", addr("SIGNER_REGISTRY"));
  for (const p of providers) await mirrorProvider(p);
}
