// Real 0G Compute client, Direct mode: the relayer talks to the TeeML provider's broker
// endpoint itself (no router in between), so it holds the exact request and response bytes
// that the enclave hashes and signs:  hex(sha256(req)) ":" hex(sha256(resp)), EIP-191.
// (0g-serving-broker api/inference/internal/ctrl/signing.go, signChatWithKey.)
//
// Also: on-chain Service lookup on 0G chain, provider signature fetch, local verification
// identical to 0g-compute-ts-sdk Verifier.verifySignature, and the public router catalog.

import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { ethers } from "ethers";
import { createPublicClient, http, verifyMessage, type Address, type Hex } from "viem";

export const ROUTER = process.env.ZG_ROUTER ?? "https://router-api.0g.ai/v1";
export const ZG_RPC = process.env.ZG_RPC ?? "https://evmrpc.0g.ai";
// InferenceServing: mainnet 0x47340d900bdFec2BD393c626E12ea0656F938d84, Galileo 0xa79F4c8311FF93C06b8CfB403690cc987c93F91E
export const INFERENCE_SERVING = (process.env.ZG_INFERENCE_SERVING ?? "0x47340d900bdFec2BD393c626E12ea0656F938d84") as Address;

// ---- on-chain Service record ------------------------------------------------

export const inferenceServingAbi = [
  {
    type: "function", name: "getService", stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [{
      name: "service", type: "tuple",
      components: [
        { name: "provider", type: "address" },
        { name: "serviceType", type: "string" },
        { name: "url", type: "string" },
        { name: "inputPrice", type: "uint256" },
        { name: "outputPrice", type: "uint256" },
        { name: "updatedAt", type: "uint256" },
        { name: "model", type: "string" },
        { name: "verifiability", type: "string" },
        { name: "additionalInfo", type: "string" },
        { name: "teeSignerAddress", type: "address" },
        { name: "teeSignerAcknowledged", type: "bool" },
      ],
    }],
  },
  {
    type: "function", name: "getAllServices", stateMutability: "view",
    inputs: [{ name: "offset", type: "uint256" }, { name: "limit", type: "uint256" }],
    outputs: [
      {
        name: "services", type: "tuple[]",
        components: [
          { name: "provider", type: "address" },
          { name: "serviceType", type: "string" },
          { name: "url", type: "string" },
          { name: "inputPrice", type: "uint256" },
          { name: "outputPrice", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
          { name: "model", type: "string" },
          { name: "verifiability", type: "string" },
          { name: "additionalInfo", type: "string" },
          { name: "teeSignerAddress", type: "address" },
          { name: "teeSignerAcknowledged", type: "bool" },
        ],
      },
      { name: "total", type: "uint256" },
    ],
  },
] as const;

export interface ServiceRecord {
  provider: Address;
  url: string;
  model: string;
  verifiability: string;
  additionalInfo: string;
  teeSignerAddress: Address;
  teeSignerAcknowledged: boolean;
  signer: Address;     // effective signer after TargetSeparated handling
  block: bigint;       // 0G block the record was read at
}

export const zgChain = {
  id: Number(process.env.ZG_CHAIN_ID ?? 16661),
  name: "0G",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: { default: { http: [ZG_RPC] } },
} as const;

export const zgClient = createPublicClient({ chain: zgChain, transport: http(ZG_RPC) });

export async function getService(provider: Address): Promise<ServiceRecord> {
  const block = await zgClient.getBlockNumber();
  const s = await zgClient.readContract({
    address: INFERENCE_SERVING, abi: inferenceServingAbi, functionName: "getService", args: [provider], blockNumber: block,
  });
  let signer = s.teeSignerAddress;
  try {
    const info = JSON.parse(s.additionalInfo || "{}");
    // Mirrors 0g-compute-ts-sdk ResponseProcessor: decentralized + TargetSeparated => TargetTeeAddress
    if (info.TargetSeparated === true && info.ProviderType !== "centralized" && info.TargetTeeAddress) {
      signer = info.TargetTeeAddress as Address;
    }
  } catch { /* additionalInfo not JSON: keep teeSignerAddress */ }
  return {
    provider: s.provider, url: s.url, model: s.model, verifiability: s.verifiability,
    additionalInfo: s.additionalInfo, teeSignerAddress: s.teeSignerAddress,
    teeSignerAcknowledged: s.teeSignerAcknowledged, signer, block,
  };
}

// ---- Direct-mode broker (wallet-signed billing headers) -----------------------------

let brokerPromise: ReturnType<typeof createZGComputeNetworkBroker> | undefined;

export function zgWallet(): ethers.Wallet {
  const pk = process.env.ZG_PRIVATE_KEY;
  if (!pk) throw new Error("ZG_PRIVATE_KEY is not set. Direct mode needs a 0G wallet (Galileo testnet or mainnet) funded with >= 3 0G ledger + 1 0G per provider (see README).");
  return new ethers.Wallet(pk, new ethers.JsonRpcProvider(ZG_RPC));
}

export function broker() {
  if (!brokerPromise) brokerPromise = createZGComputeNetworkBroker(zgWallet());
  return brokerPromise;
}

export interface DirectResult {
  reqBody: Uint8Array;
  respBody: Uint8Array;
  json: any;
  content: string;
  chatId: string;
  requestId: string;
}

/** POST the exact bytes to the provider and keep the exact bytes it returns. */
export async function directChat(provider: Address, body: Record<string, unknown>): Promise<DirectResult> {
  const b = await broker();
  const { endpoint, model } = await b.inference.getServiceMetadata(provider);
  const headers = await b.inference.getRequestHeaders(provider);
  const reqText = JSON.stringify({ ...body, model });
  const reqBody = new TextEncoder().encode(reqText);
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
    body: reqBody,
  });
  const respBody = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(respBody);
  if (!res.ok) throw new Error(`provider ${provider} HTTP ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  const content: string = json.choices?.[0]?.message?.content ?? "";
  const chatId = res.headers.get("ZG-Res-Key") ?? res.headers.get("zg-res-key") ?? json.id;
  if (!chatId) throw new Error("no ZG-Res-Key header and no id in the response");
  return { reqBody, respBody, json, content, chatId, requestId: json.id ?? chatId };
}

// ---- signature fetch + verify ---------------------------------------------------

export interface ProviderSignature {
  text: string;
  signature: Hex;
  signing_address?: Address;
  signing_algo?: string;
}

/** GET {service.url}/v1/proxy/signature/{chatID}?model= — the same call the SDK makes. */
export async function fetchSignature(svc: ServiceRecord, chatId: string): Promise<ProviderSignature> {
  const base = svc.url.replace(/\/+$/, "");
  const url = `${base}/v1/proxy/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(svc.model)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`signature fetch ${res.status} from ${url}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as ProviderSignature;
  if (typeof j.text !== "string" || typeof j.signature !== "string") throw new Error(`unexpected signature payload: ${JSON.stringify(j).slice(0, 300)}`);
  if (!j.signature.startsWith("0x")) j.signature = `0x${j.signature}` as Hex;
  return j;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(data).buffer as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the broker signs for this pair. */
export async function expectedSignedText(reqBody: Uint8Array, respBody: Uint8Array): Promise<string> {
  return `${await sha256Hex(reqBody)}:${await sha256Hex(respBody)}`;
}

/** EIP-191 personal_sign verification, as the contract will do it. */
export async function verifyAttestation(text: string, signature: Hex, signer: Address): Promise<boolean> {
  return verifyMessage({ address: signer, message: text, signature });
}

// ---- public catalog ----------------------------------------------------------

export async function teeModels(): Promise<{ id: string; type: string; verifiability: string; provider_count: number }[]> {
  const res = await fetch(`${ROUTER}/models`);
  const j = await res.json();
  return (j.data as any[]).filter((m) => m.tee_attested).map((m) => ({
    id: m.id, type: m.type, verifiability: m.verifiability, provider_count: m.provider_count,
  }));
}

/** True when ZG_CHAIN_ID is 0G mainnet; the public router only catalogs mainnet. */
export const ZG_IS_MAINNET = zgChain.id === 16661;

/** Every TeeML service on InferenceServing whose signer 0G has acknowledged. */
export async function chainTeeServices() {
  const out: { provider: Address; model: string; signer: Address }[] = [];
  const page = 50n;
  for (let offset = 0n; ; offset += page) {
    const [services, total] = await zgClient.readContract({
      address: INFERENCE_SERVING, abi: inferenceServingAbi, functionName: "getAllServices", args: [offset, page],
    });
    for (const s of services) {
      if (s.verifiability === "TeeML" && s.teeSignerAcknowledged) {
        out.push({ provider: s.provider, model: s.model, signer: s.teeSignerAddress });
      }
    }
    if (offset + page >= total) break;
  }
  return out;
}

/**
 * TeeML provider for a model. Order: PROVIDER_<MODEL> env override, then the public router
 * (mainnet only), otherwise InferenceServing.getAllServices on the configured 0G chain.
 */
export async function pickProvider(model: string): Promise<Address> {
  const env = process.env[`PROVIDER_${model.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`];
  if (env) return env as Address;
  if (ZG_IS_MAINNET && process.env.ZG_PROVIDER_SOURCE !== "chain") {
    const res = await fetch(`${ROUTER}/providers?model=${encodeURIComponent(model)}`);
    const j: any = await res.json();
    const p = (j.data as any[]).find((x) => x.verifiability === "TeeML" && x.address && x.tee_acknowledged);
    if (!p) throw new Error(`no TeeML provider listed for ${model}`);
    return p.address as Address;
  }
  const want = model.toLowerCase();
  const p = (await chainTeeServices()).find((s) => s.model.toLowerCase() === want);
  if (!p) throw new Error(`no acknowledged TeeML service for ${model} on ${INFERENCE_SERVING} (chain ${zgChain.id})`);
  return p.provider;
}
