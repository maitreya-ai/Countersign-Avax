// Parity: the TypeScript terms hash, escrow id, receipt digest and validation request hash must
// equal what the deployed contracts compute. Spins up anvil and deploys the forge artifacts.
//   (cd contracts && forge build) && bun test packages/x402-countersign
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, hashTypedData, http, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { escrowAbi, validatorAbi } from "../src/abi";
import { receiptDomain, receiptTypes, signReceipt, verifyReceipt } from "../src/eip712";
import { NO_AGENT, TERMS_TAG, escrowIdFor, requestHashFor, rubricHashOf, termsHash } from "../src/terms";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const artifact = (name: string) => JSON.parse(readFileSync(`${ROOT}contracts/out/${name}.sol/${name}.json`, "utf8"));
const haveArtifacts = existsSync(`${ROOT}contracts/out/CountersignEscrow.sol/CountersignEscrow.json`);
const PORT = 18545 + Math.floor(Math.random() * 1000);
const rpc = `http://127.0.0.1:${PORT}`;
const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex; // anvil #0
const account = privateKeyToAccount(pk);
const chain = { ...foundry, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let escrow: Address;
let validator: Address;

async function deploy(name: string, args: unknown[]): Promise<Address> {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}

beforeAll(async () => {
  if (!haveArtifacts) return;
  anvil = Bun.spawn(["anvil", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { await pub.getChainId(); break; } catch { await Bun.sleep(100); }
  }
  const registry = await deploy("SignerRegistry", [account.address]);
  const oracle = await deploy("CountersignOracle", [registry]);
  escrow = await deploy("CountersignEscrow", ["0x0000000000000000000000000000000000000001", oracle]);
  validator = await deploy("CountersignValidator", [
    "0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003", escrow, "https://n/escrows/", account.address,
  ]);
}, 30_000);

afterAll(() => anvil?.kill());

const policy = { judges: 2, minAgree: 2, minConfBps: 8500, requireGrounded: true };
const cases = [
  { payee: "0x5e8508CAE8e70A6308D840441cd813Ba80A900fE" as Address, arbiter: "0x0000000000000000000000000000000000000000" as Address, amount: 250_000n, deadline: 1_800_000_900n, agentId: 296n, salt: toHex(new Uint8Array(32).fill(7)), rubric: "Exactly 5 bullets." },
  { payee: "0x00422722F97ea5e206b08Ef4267243cc30f33961" as Address, arbiter: "0x00000000000000000000000000000000000000ab" as Address, amount: 1n, deadline: 2n ** 63n, agentId: NO_AGENT, salt: keccak256(toHex("s")), rubric: "ünïcødé rubric ✓" },
];

describe.skipIf(!haveArtifacts)("TS <-> Solidity parity", () => {
  test("TERMS_TAG", async () => {
    expect(await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "TERMS_TAG" })).toBe(TERMS_TAG);
  });

  for (const [i, c] of cases.entries()) {
    test(`termsHash + escrowIdFor (case ${i})`, async () => {
      const rubricHash = rubricHashOf(c.rubric);
      const onchain = await pub.readContract({
        address: escrow, abi: escrowAbi, functionName: "termsHash",
        args: [c.payee, c.arbiter, c.amount, c.deadline, rubricHash, policy, c.agentId, c.salt],
      });
      const local = termsHash({ chainId: foundry.id, escrow, payee: c.payee, arbiter: c.arbiter, amount: c.amount, deadline: c.deadline, rubricHash, policy, agentId: c.agentId, salt: c.salt });
      expect(local).toBe(onchain);
      const id = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "escrowIdFor", args: [account.address, local] });
      expect(escrowIdFor(account.address, local)).toBe(id);
    });
  }

  test("receipt digest and signature", async () => {
    const id = keccak256(toHex("escrow"));
    const h = keccak256(toHex("evidence"));
    const onchain = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "receiptDigest", args: [id, h] });
    const local = hashTypedData({ domain: receiptDomain(foundry.id, escrow), types: receiptTypes, primaryType: "Receipt", message: { escrowId: id, evidenceHash: h } });
    expect(local).toBe(onchain);
    const sig = await signReceipt(account, foundry.id, escrow, id, h);
    expect(await verifyReceipt(account.address, foundry.id, escrow, id, h, sig)).toBe(true);
    expect(await verifyReceipt(account.address, foundry.id, escrow, id, keccak256(toHex("other")), sig)).toBe(false);
  });

  test("validation requestHashFor", async () => {
    const id = keccak256(toHex("escrow"));
    const onchain = await pub.readContract({ address: validator, abi: validatorAbi, functionName: "requestHashFor", args: [id, 296n] });
    expect(requestHashFor(id, 296n)).toBe(onchain);
  });
});
