// Arc testnet clients and contract bindings.

import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ARC_RPC = process.env.ARC_RPC ?? "https://rpc.testnet.arc.io";
export const ARC_EXPLORER = "https://explorer.testnet.arc.io";
export const USDC = (process.env.USDC ?? "0x3600000000000000000000000000000000000000") as Address;

export const arcTestnet = {
  id: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
  blockExplorers: { default: { name: "Arc Explorer", url: ARC_EXPLORER } },
} as const;

export const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });

export function wallet(pkEnv = "ARC_PRIVATE_KEY") {
  const pk = process.env[pkEnv];
  if (!pk) throw new Error(`${pkEnv} is not set`);
  const account = privateKeyToAccount(pk as Hex);
  return { account, client: createWalletClient({ account, chain: arcTestnet, transport: http(ARC_RPC) }) };
}

export function addr(env: string): Address {
  const v = process.env[env];
  if (!v) throw new Error(`${env} is not set (deploy with contracts/script/Deploy.s.sol first)`);
  return v as Address;
}

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const registryAbi = parseAbi([
  "function sync(address provider, address signer, string model, uint64 zgBlock, bytes32 zgTxHash)",
  "function revoke(address signer)",
  "function isSigner(address signer) view returns (bool)",
  "function modelOf(address signer) view returns (bytes32)",
  "function providerOf(address signer) view returns (address)",
  "function owner() view returns (address)",
  "event Synced(address indexed signer, address indexed provider, string model, uint64 zgBlock, bytes32 zgTxHash)",
]);

export const escrowAbi = parseAbi([
  "struct Policy { uint8 judges; uint8 minAgree; uint16 minConfBps; bool requireGrounded; }",
  "struct Attested { bytes reqBody; bytes respBody; bytes signature; address provider; }",
  "function open(address payee, address arbiter, uint96 amount, uint64 deadline, string rubric, Policy policy) returns (bytes32)",
  "function setEvidence(bytes32 id, bytes32 evidenceHash, string storageRef)",
  "function settle(bytes32 id, Attested[] judges, Attested grounding, Attested calibration, string[] requestIds)",
  "function arbitrate(bytes32 id, bool release)",
  "function refundAfterDeadline(bytes32 id)",
  "function get(bytes32 id) view returns ((address payer, address payee, address arbiter, uint96 amount, uint64 deadline, bytes32 rubricHash, bytes32 evidenceHash, (uint8 judges, uint8 minAgree, uint16 minConfBps, bool requireGrounded) policy, uint8 state))",
  "function oracle() view returns (address)",
  "function usdc() view returns (address)",
  "event Opened(bytes32 indexed id, address indexed payer, address indexed payee, uint96 amount, uint64 deadline, bytes32 rubricHash, string rubric)",
  "event EvidenceSet(bytes32 indexed id, bytes32 evidenceHash, string storageRef)",
  "event Settled(bytes32 indexed id, uint8 outcome, address[] signers, string[] requestIds)",
]);

export const oracleAbi = parseAbi([
  "struct Policy { uint8 judges; uint8 minAgree; uint16 minConfBps; bool requireGrounded; }",
  "struct Attested { bytes reqBody; bytes respBody; bytes signature; address provider; }",
  "function signedText(bytes reqBody, bytes respBody) pure returns (bytes)",
  "function verifyOne(bytes32 rubricHash, bytes32 evidenceHash, Attested a) view returns (uint8 verdict, uint16 confBps, address signer, bytes32 model)",
  "function resolve(bytes32 rubricHash, bytes32 evidenceHash, Policy p, Attested[] judges, Attested grounding, Attested calibration) view returns (uint8 outcome, address[] signers)",
  "function registry() view returns (address)",
]);

export const STATE = ["None", "Open", "Resolved", "Refunded", "Escalated"] as const;
export const OUTCOME = ["NO (refund)", "YES (release)", "ESCALATE"] as const;

export function tx(hash: Hex) { return `${ARC_EXPLORER}/tx/${hash}`; }
