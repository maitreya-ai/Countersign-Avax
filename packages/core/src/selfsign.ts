// Self-attested judges: call an OpenAI-compatible chat API, keep the exact request and response
// bytes, and sign  hex(sha256(req)) ":" hex(sha256(resp))  with EIP-191 (the layout TEE inference
// gateways use, so the oracle can later accept enclave keys unchanged).
//
// TRUST: in this mode the judge node holds the signing keys; it could sign a reply the API never
// sent. The contracts prove the binding, policy and payout logic, not model provenance.
//
// Model ids carry their backend: "groq:openai/gpt-oss-120b", "gemini:gemini-2.5-flash",
// "local:llama3.1" (LOCAL_LLM_URL, any OpenAI-compatible server such as Ollama).
// Each model signs with its own key, keccak256(ATTESTER_PRIVATE_KEY ‖ model), because
// SignerRegistry stores one model per signer and the oracle requires distinct judge models.

import { bytesToHex, concat, keccak256, toHex, verifyMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

interface Backend { url: () => string; keyEnv?: string; extra?: Record<string, unknown> }

// Groq returns a `reasoning` field for some models that can quote a draft "VERDICT:" header; the
// oracle reads the first one in the bytes, so reasoning is turned off. Hidden reasoning still
// spends completion tokens, so Groq gets a larger cap.
const BACKENDS: Record<string, Backend> = {
  groq: { url: () => "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", extra: { include_reasoning: false, max_tokens: 4096 } },
  gemini: { url: () => "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY" },
  local: { url: () => `${(process.env.LOCAL_LLM_URL ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "")}/chat/completions` },
};

export function isSelfModel(model: string): boolean {
  return model.includes(":") && model.split(":")[0]! in BACKENDS;
}

export function selfAccount(model: string) {
  const root = process.env.ATTESTER_PRIVATE_KEY;
  if (!root) throw new Error("ATTESTER_PRIVATE_KEY is not set");
  return privateKeyToAccount(keccak256(concat([root as Hex, toHex(model)])));
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))).slice(2);
}

/** The exact text a judge signer signs (matches AssayOracle.signedText). */
export async function expectedSignedText(reqBody: Uint8Array, respBody: Uint8Array): Promise<string> {
  return `${await sha256Hex(reqBody)}:${await sha256Hex(respBody)}`;
}

export async function verifyAttestation(text: string, signature: Hex, signer: Address): Promise<boolean> {
  return verifyMessage({ address: signer, message: text, signature });
}

export interface SelfResult {
  reqBody: Uint8Array;
  respBody: Uint8Array;
  content: string;
  requestId: string;
  signedText: string;
  signature: Hex;
  signer: Address;
}

/** POST the exact bytes, keep the exact reply, sign sha256(req):sha256(resp). */
export async function selfChat(model: string, body: Record<string, unknown>): Promise<SelfResult> {
  const [backend, ...rest] = model.split(":");
  const b = BACKENDS[backend!]!;
  const key = b.keyEnv ? process.env[b.keyEnv] : undefined;
  if (b.keyEnv && !key) throw new Error(`${b.keyEnv} is not set (needed for ${model})`);
  const reqBody = new TextEncoder().encode(JSON.stringify({ ...body, ...b.extra, model: rest.join(":") }));
  let res: Response, respBody: Uint8Array, text: string;
  for (let wait = 0; ; wait++) {
    res = await fetch(b.url(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: reqBody as BodyInit,
    });
    respBody = new Uint8Array(await res.arrayBuffer());
    text = new TextDecoder().decode(respBody);
    // free tiers rate-limit per minute: wait as told ("try again in 4.74s" / retry-after), up to 5 times
    if (res.status !== 429 || wait >= 5) break;
    const s = Number(res.headers.get("retry-after") ?? text.match(/try again in ([\d.]+)s/)?.[1] ?? 10);
    console.warn(`[${model}] 429, waiting ${Math.ceil(s + 1)}s`);
    await new Promise((r) => setTimeout(r, (s + 1) * 1000));
  }
  if (!res.ok) throw new Error(`${backend} HTTP ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  const content: string = json.choices?.[0]?.message?.content ?? "";
  const acct = selfAccount(model);
  const signedText = await expectedSignedText(reqBody, respBody);
  const signature = await acct.signMessage({ message: signedText });
  return { reqBody, respBody, content, requestId: json.id ?? `${backend}-${Date.now()}`, signedText, signature, signer: acct.address };
}
