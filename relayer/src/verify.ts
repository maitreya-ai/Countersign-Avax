// Independent verifier: re-checks a settled escrow from public data only.
//   bun run src/verify.ts <settle tx hash>
// Reads the settle calldata, recomputes hex(sha256(req)):hex(sha256(resp)) for every attestation,
// recovers the EIP-191 signer, reads the provider's Service record from 0G chain, and compares.
// No trust in the relayer, the router, or the SignerRegistry owner.

import { decodeFunctionData, hexToBytes, recoverMessageAddress, type Hex } from "viem";
import { addr, escrowAbi, publicClient, registryAbi } from "./arc";
import { parseHeader } from "./header";
import { expectedSignedText, getService } from "./zg";

const hash = process.argv[2] as Hex;
if (!hash) throw new Error("usage: bun run src/verify.ts <settle tx hash>");

const txn = await publicClient.getTransaction({ hash });
const { functionName, args } = decodeFunctionData({ abi: escrowAbi, data: txn.input });
if (functionName !== "settle") throw new Error(`not a settle tx: ${functionName}`);
const [id, judges, grounding, calibration, requestIds] = args as any;
const registry = addr("SIGNER_REGISTRY");

console.log(`escrow ${id}`);
const all = [...judges.map((j: any, i: number) => ({ role: `judge ${i + 1}`, ...j })), { role: "grounding", ...grounding }, { role: "calibration", ...calibration }];
let ok = true;
let selfCount = 0;
for (const [i, a] of all.entries()) {
  const req = hexToBytes(a.reqBody), resp = hexToBytes(a.respBody);
  const text = await expectedSignedText(req, resp);
  const signer = await recoverMessageAddress({ message: text, signature: a.signature });
  const json = JSON.parse(new TextDecoder().decode(resp));
  const h = parseHeader(json.choices[0].message.content);
  const registered = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: "providerOf", args: [signer] });
  if (a.provider.toLowerCase() === signer.toLowerCase()) {
    // self-attested mode (selfsign.ts): provider id == signer, nothing on 0G to compare against
    const reg = registered.toLowerCase() === signer.toLowerCase();
    console.log(`${a.role.padEnd(12)} verdict=${h.verdict} conf=${h.conf} model=${json.model ?? "?"}`);
    console.log(`             signed text ${text}`);
    console.log(`             recovered ${signer}  SELF-ATTESTED (relayer key, not an enclave)  registry ${reg ? "OK" : "MISSING"}`);
    console.log(`             response id ${requestIds[i]}`);
    if (!reg) ok = false;
    selfCount++;
    continue;
  }
  const svc = await getService(a.provider);
  const matches = svc.signer.toLowerCase() === signer.toLowerCase();
  console.log(`${a.role.padEnd(12)} verdict=${h.verdict} conf=${h.conf} model=${svc.model}`);
  console.log(`             signed text ${text}`);
  console.log(`             recovered ${signer}  0G Service.signer ${svc.signer}  ${matches ? "OK" : "MISMATCH"}`);
  console.log(`             response id ${requestIds[i]}  registry.providerOf ${registered}`);
  if (!matches) ok = false;
}
console.log(!ok ? "\nFAILED" : selfCount
  ? `\nall signatures recover to registered signers; ${selfCount} of ${all.length} are self-attested by the relayer (not enclave-backed)`
  : "\nall signatures recover to the enclave signers published on 0G chain");
