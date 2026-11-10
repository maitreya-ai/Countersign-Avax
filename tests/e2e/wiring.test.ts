// End-to-end: frontend <-> backend <-> chain wiring, on an anvil fork of Avalanche Fuji (real Circle
// USDC and real ERC-8004 registries). Deploys fresh contracts, registers four sellers, runs the real
// node (published under /api, exactly like the Cloudflare deployment) with a deterministic test
// judge, buys from every seller, and checks that the dapp's chain reader and in-browser verifier
// see exactly what the node and the contracts did.
//   bun run test:e2e         (needs anvil + network access to the Fuji RPC)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256,
  numberToHex, parseEther, parseEventLogs, toBytes, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  HEADERS, VALIDATION_TAG_STRING, decodeHeader, fetchWithCountersign, identityRegistryAbi, validationRegistryAbi,
  type PaymentRequired, type Purchase,
} from "@countersign/x402";
import { ARTICLE } from "../../demo/agent/src/article";
import { createChainReader, type ReasonName } from "../../web/lib/chain";
import { verifyInBrowser } from "../../web/lib/verify";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FUJI_RPC = process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65" as Address;
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const VALIDATION = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Address;
const SELLERS = ["honest", "lazy", "injector", "swapper"] as const;
const EXPECTED: Record<string, { reason: ReasonName; score: number }> = {
  honest: { reason: "VerdictYes", score: 100 },
  lazy: { reason: "VerdictNo", score: 0 },
  injector: { reason: "VerdictNo", score: 0 },
  swapper: { reason: "Equivocation", score: 0 },
};

const seed = 1000 + Math.floor(Math.random() * 8000);
const ANVIL = `http://127.0.0.1:${seed + 10000}`;
const NODE_PORT = seed + 20000;
const LLM_PORT = seed + 30000;
const NODE = `http://127.0.0.1:${NODE_PORT}/api`;

const chain = defineChain({ id: 43113, name: "Fuji fork", nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } } });
const pub = createPublicClient({ chain, transport: http(ANVIL), pollingInterval: 250 });

const keys = {
  deployer: generatePrivateKey(), attester: generatePrivateKey(), agent: generatePrivateKey(),
  honest: generatePrivateKey(), lazy: generatePrivateKey(), injector: generatePrivateKey(), swapper: generatePrivateKey(),
};
const agent = privateKeyToAccount(keys.agent);
const procs: ReturnType<typeof Bun.spawn>[] = [];
const tmp = mkdtempSync(join(tmpdir(), "countersign-e2e-"));
let contracts: Record<string, Address> = {};
let deployBlock = 0n;
const agentIds: Record<string, bigint> = {};
const purchases: Record<string, Purchase> = {};
let ready = false;

const artifact = (n: string) => JSON.parse(readFileSync(join(ROOT, `contracts/out/${n}.sol/${n}.json`), "utf8"));

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch { /* not yet */ }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function spawn(cmd: string[], env: Record<string, string>, cwd = ROOT) {
  const p = Bun.spawn(cmd, { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "ignore", stderr: "pipe" });
  procs.push(p);
  return p;
}

beforeAll(async () => {
  const reachable = await fetch(FUJI_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false);
  if (!reachable || !Bun.which("anvil")) return; // tests below are skipped
  if (!existsSync(join(ROOT, "contracts/out/CountersignEscrow.sol/CountersignEscrow.json"))) {
    await Bun.spawn(["forge", "build"], { cwd: join(ROOT, "contracts"), stdout: "ignore" }).exited;
  }

  spawn(["anvil", "--fork-url", FUJI_RPC, "--port", ANVIL.split(":")[2]!, "--silent"], {});
  await waitFor(async () => (await pub.getChainId()) === 43113, 60_000, "anvil");

  // fund: AVAX for the deployer (keeper) and sellers; real Fuji USDC for the agent (FiatToken slot 9)
  const t = createTestClient({ mode: "anvil", chain, transport: http(ANVIL) });
  for (const k of ["deployer", "honest", "lazy", "injector", "swapper"] as const) {
    await t.setBalance({ address: privateKeyToAccount(keys[k]).address, value: parseEther("100") });
  }
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [agent.address, 9n]));
  await t.setStorageAt({ address: USDC, index: slot, value: numberToHex(20_000_000n, { size: 32 }) });

  // deploy
  const deployer = privateKeyToAccount(keys.deployer);
  const w = createWalletClient({ account: deployer, chain, transport: http(ANVIL) });
  const deploy = async (name: string, args: unknown[]) => {
    const a = artifact(name);
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  deployBlock = await pub.getBlockNumber();
  const registry = await deploy("SignerRegistry", [deployer.address]);
  const oracle = await deploy("CountersignOracle", [registry]);
  const escrow = await deploy("CountersignEscrow", [USDC, oracle]);
  const validator = await deploy("CountersignValidator", [VALIDATION, IDENTITY, escrow, `${NODE}/escrows/`, deployer.address]);
  contracts = { registry, oracle, escrow, validator };

  // sellers: ERC-8004 identities + validator approval
  for (const name of SELLERS) {
    const sw = createWalletClient({ account: privateKeyToAccount(keys[name]), chain, transport: http(ANVIL) });
    const h = await sw.writeContract({ address: IDENTITY, abi: identityRegistryAbi, functionName: "register", args: [`https://example.test/${name}.json`] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    agentIds[name] = parseEventLogs({ abi: identityRegistryAbi, logs: r.logs, eventName: "Registered" })[0]!.args.agentId;
    await pub.waitForTransactionReceipt({ hash: await sw.writeContract({ address: IDENTITY, abi: identityRegistryAbi, functionName: "approve", args: [validator, agentIds[name]!] }) });
  }

  const deploymentFile = join(tmp, "deployment.json");
  writeFileSync(deploymentFile, JSON.stringify({
    chainId: 43113, deployBlock: Number(deployBlock),
    contracts: { usdc: USDC, signerRegistry: registry, oracle, escrow, validator, identityRegistry: IDENTITY, validationRegistry: VALIDATION },
    sellers: SELLERS.map((n) => ({ name: n, address: privateKeyToAccount(keys[n]).address, agentId: agentIds[n]!.toString(), resource: `${NODE}/${n}/summarize` })),
  }));
  const emptyEnv = join(tmp, "empty.env");
  writeFileSync(emptyEnv, "");

  spawn(["bun", `--env-file=${emptyEnv}`, "run", "scripts/mock-llm.ts"], { MOCK_LLM_PORT: String(LLM_PORT) });
  spawn(["bun", `--env-file=${emptyEnv}`, "run", "services/node/src/index.ts"], {
    CHAIN_ID: "43113", RPC_URL: ANVIL, USDC, ERC8004_IDENTITY: IDENTITY, ERC8004_VALIDATION: VALIDATION,
    SIGNER_REGISTRY: registry, COUNTERSIGN_ORACLE: oracle, COUNTERSIGN_ESCROW: escrow, COUNTERSIGN_VALIDATOR: validator,
    DEPLOYER_PRIVATE_KEY: keys.deployer, ATTESTER_PRIVATE_KEY: keys.attester, AGENT_PRIVATE_KEY: keys.agent,
    SELLER_HONEST_PRIVATE_KEY: keys.honest, SELLER_LAZY_PRIVATE_KEY: keys.lazy, SELLER_INJECTOR_PRIVATE_KEY: keys.injector, SELLER_SWAPPER_PRIVATE_KEY: keys.swapper,
    JUDGES: "2", JUDGE_A: "local:mock-judge-a", JUDGE_B: "local:mock-judge-b", GROUNDING: "local:mock-grounding", CALIBRATION: "local:mock-calibration",
    LOCAL_LLM_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
    NODE_PORT: String(NODE_PORT), NODE_URL: NODE, SELLERS_URL: NODE, MOUNT_SELLERS: "1", DEMO_ENABLED: "1",
    NODE_DB: join(tmp, "node.db"), DEPLOYMENT_FILE: deploymentFile, DEADLINE_SECONDS: "600",
    CHALLENGE_SECONDS: "1", KEEPER_INTERVAL_MS: "1000", LOG_BLOCK_RANGE: "2000",
  });
  await waitFor(async () => (await fetch(`${NODE}/health`)).ok, 60_000, "node");
  ready = true;
}, 240_000);

afterAll(() => {
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
});

const it = (name: string, fn: () => Promise<void>, timeout: number) => test(name, async () => {
  if (!ready) {
    if (process.env.E2E_ALLOW_SKIP === "1") { console.warn(`skipped (no anvil or no network): ${name}`); return; }
    throw new Error("e2e environment unavailable (needs anvil and the Fuji RPC); set E2E_ALLOW_SKIP=1 to skip");
  }
  await fn();
}, timeout);

describe("countersign e2e (Fuji fork)", () => {
  it("node serves every route the dapp and agents call, under the /api base path", async () => {
    const cfg = await (await fetch(`${NODE}/config`)).json();
    expect(cfg.chainId).toBe(43113);
    expect(cfg.contracts.escrow.toLowerCase()).toBe(contracts.escrow!.toLowerCase());
    expect(cfg.nodeUrl).toBe(NODE);
    for (const p of ["/health", "/stats", "/sellers", "/escrows", "/activity", "/facilitator/supported"]) {
      expect((await fetch(`${NODE}${p}`)).status).toBe(200);
    }
    const supported = await (await fetch(`${NODE}/facilitator/supported`)).json();
    expect(supported.kinds.map((k: any) => k.scheme)).toEqual(["exact", "countersign"]);

    // an unpaid call to a seller returns a 402 offering both schemes, wired to this node
    const res = await fetch(`${NODE}/honest/summarize`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"document":"A short document."}' });
    expect(res.status).toBe(402);
    const offer = decodeHeader<PaymentRequired>(res.headers.get(HEADERS.required)!);
    expect(offer.accepts.map((a) => a.scheme)).toEqual(["exact", "countersign"]);
    const cs = offer.accepts[1]!;
    expect(cs.extra.facilitator).toBe(NODE);
    expect(cs.extra.agentId).toBe(agentIds.honest!.toString());
    expect(cs.payTo).toBe(privateKeyToAccount(keys.honest).address);
    expect(cs.resource).toBe(`${NODE}/honest/summarize`);
  }, 30_000);

  it("buys from all four sellers; the receipts match the bytes received", async () => {
    for (const name of SELLERS) {
      const p = await fetchWithCountersign(`${NODE}/${name}/summarize`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: ARTICLE, bullets: 5 }),
      }, { account: agent, publicClient: pub as any, maxAmount: 1_000_000n });
      expect(p.response.status).toBe(200);
      expect(p.receiptValid).toBe(true);
      purchases[name] = p;
    }
  }, 60_000);

  it("the contract settles each purchase as designed and writes the ERC-8004 record", async () => {
    const finals = await Promise.all(SELLERS.map((n) => purchases[n]!.watch({ intervalMs: 500, timeoutMs: 120_000 })));
    SELLERS.forEach((n, i) => expect(finals[i]!.reason).toBe(EXPECTED[n]!.reason));
    for (const n of SELLERS) {
      await waitFor(async () => {
        const [count] = await pub.readContract({ address: VALIDATION, abi: validationRegistryAbi, functionName: "getSummary", args: [agentIds[n]!, [contracts.validator!], VALIDATION_TAG_STRING] });
        return count === 1n;
      }, 60_000, `${n} ERC-8004 record`);
      const [, avg] = await pub.readContract({ address: VALIDATION, abi: validationRegistryAbi, functionName: "getSummary", args: [agentIds[n]!, [contracts.validator!], VALIDATION_TAG_STRING] });
      expect(avg).toBe(EXPECTED[n]!.score);
    }
  }, 240_000);

  it("the dapp's chain reader reconstructs exactly what the node reports", async () => {
    const reader = createChainReader({
      chainId: 43113, rpc: ANVIL, logRpc: ANVIL, logRange: 50_000n, deployBlock,
      contracts: { escrow: contracts.escrow!, validator: contracts.validator!, validationRegistry: VALIDATION },
      sellers: SELLERS.map((n) => ({ name: n, address: privateKeyToAccount(keys[n]).address, agentId: agentIds[n]!.toString() })),
    });
    const snap = await reader.scanOnce();
    const node = (await (await fetch(`${NODE}/escrows?limit=50`)).json()).escrows as any[];
    expect(snap.escrows.length).toBe(SELLERS.length);
    for (const e of snap.escrows) {
      const n = node.find((x) => x.id.toLowerCase() === e.id.toLowerCase());
      expect(n).toBeDefined();
      expect(e.reason).toBe(n.reason);
      expect(e.state).toBe(n.state);
      expect(e.score).toBe(n.score);
      expect(e.seller).toBe(n.seller);
      expect(e.reason).toBe(EXPECTED[e.seller!]!.reason);
    }
    // judged evidence decoded from settle calldata is exactly what was committed on-chain
    const honest = snap.escrows.find((e) => e.seller === "honest")!;
    const decoded = await reader.decodeSettle(honest.tx.settle!);
    expect(decoded.attestations.map((a) => a.role)).toEqual(["judge A", "judge B", "grounding", "calibration"]);
    expect(decoded.attestations.every((a) => a.verdict === "Y")).toBe(true);
    expect(keccak256(toBytes(decoded.evidence!))).toBe(honest.evidenceHash!);
    // seller records from ERC-8004, as the leaderboard shows them
    expect(snap.records[agentIds.honest!.toString()]).toEqual({ count: 1, avg: 100, selfFiling: true });
  }, 60_000);

  it("in-browser verification passes for every purchase, from chain data only", async () => {
    const reader = createChainReader({
      chainId: 43113, rpc: ANVIL, logRpc: ANVIL, logRange: 50_000n, deployBlock,
      contracts: { escrow: contracts.escrow!, validator: contracts.validator!, validationRegistry: VALIDATION },
      sellers: [],
    });
    const snap = await reader.scanOnce();
    for (const e of snap.escrows) {
      const checks = await verifyInBrowser(e, null, {
        client: reader.callClient as any, decodeSettle: reader.decodeSettle, chainId: 43113,
        contracts: { escrow: contracts.escrow!, signerRegistry: contracts.registry!, validator: contracts.validator!, validationRegistry: VALIDATION },
      });
      const failed = checks.filter((c) => !c.ok).map((c) => c.label);
      expect(failed).toEqual([]);
      expect(checks.length).toBeGreaterThan(e.tx.settle ? 10 : 2);
    }
  }, 60_000);

  it("the Try page's demo endpoint opens a judged purchase", async () => {
    const r = await fetch(`${NODE}/demo/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"seller":"lazy"}' });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.escrowId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(j.receiptValid).toBe(true);
  }, 60_000);
});
