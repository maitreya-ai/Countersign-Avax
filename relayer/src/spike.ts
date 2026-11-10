// H0 spike: prove the full attestation path for one model with real 0G inference in Direct mode.
//   bun run src/spike.ts [model]
// Prints: provider, Service record, response id, ZG-Res-Key, the provider's signed text vs our
// sha256(req):sha256(resp), and the local EIP-191 verification result.

import { keccak256, toHex } from "viem";
import { buildHeader } from "./header";
import { directChat, expectedSignedText, fetchSignature, getService, pickProvider, teeModels, verifyAttestation, ZG_IS_MAINNET } from "./zg";

const model = process.argv[2] ?? process.env.JUDGE_A ?? "glm-5.3";

if (ZG_IS_MAINNET) { // the public router only catalogs mainnet
  console.log("TeeML models on the router:");
  for (const m of await teeModels()) console.log(`  ${m.id.padEnd(24)} ${m.type.padEnd(16)} ${m.verifiability} providers=${m.provider_count}`);
}

const provider = await pickProvider(model);
const svc = await getService(provider);
console.log(`\nprovider ${provider}  Service @0G block ${svc.block}`);
console.log("  url          :", svc.url);
console.log("  model        :", svc.model);
console.log("  verifiability:", svc.verifiability);
console.log("  teeSigner    :", svc.teeSignerAddress, svc.teeSignerAcknowledged ? "(acknowledged)" : "(NOT acknowledged)");
console.log("  effective    :", svc.signer);

const rubricHash = keccak256(toHex("spike rubric"));
const evidenceHash = keccak256(toHex("spike evidence"));
const want = buildHeader({ verdict: "Y", conf: 1, rubricHash, evidenceHash });

console.log(`\ncalling ${svc.model} directly at ${svc.url} ...`);
const r = await directChat(provider, {
  messages: [
    { role: "system", content: `Reply with exactly this line and nothing else:\n${want}` },
    { role: "user", content: "Go." },
  ],
  temperature: 0, max_tokens: 300,
});
console.log("response id  :", r.requestId);
console.log("ZG-Res-Key   :", r.chatId);
console.log("content      :", JSON.stringify(r.content.slice(0, 200)));
console.log("header match :", r.content.startsWith(want));
console.log("bytes        : req", r.reqBody.length, "resp", r.respBody.length);

const sig = await fetchSignature(svc, r.chatId);
const ours = await expectedSignedText(r.reqBody, r.respBody);
console.log("\nprovider signed text :", sig.text);
console.log("sha256(req):sha256(resp):", ours);
console.log("match                :", sig.text === ours);
console.log("signature            :", sig.signature);
console.log("signing_address      :", sig.signing_address);
console.log("EIP-191 verify vs effective signer:", await verifyAttestation(sig.text, sig.signature, svc.signer));
