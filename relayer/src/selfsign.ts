// Self-attested mode: no 0G. The relayer calls a free OpenAI-compatible API (Groq, Gemini),
// keeps the exact request and response bytes, and signs the same text a 0G TeeML broker would:
//   hex(sha256(req)) ":" hex(sha256(resp)), EIP-191 personal_sign.
// The contracts are unchanged. TRUST: the relayer is the signer here; it could sign a reply
// the API never sent. This mode proves the escrow logic end to end, not provenance.
//
// Model ids carry their backend: "groq:llama-3.3-70b-versatile", "gemini:gemini-2.5-flash".
// Each model signs with its own key, keccak256(ATTESTER_PRIVATE_KEY ‖ model), because
// SignerRegistry stores one model per signer and the oracle requires distinct judge models.

import { concat, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expectedSignedText } from "./zg";

// extra: request fields per backend. Groq returns a `reasoning` field for gpt-oss/qwen that can
// quote a draft "VERDICT:" header; the oracle reads the first one in the bytes, so drop it.
// Hidden reasoning still spends completion tokens: 1200 can run out before the answer (empty
// content), so Groq gets a larger cap. The 900-char rationale limit is enforced separately.
const BACKENDS: Record<string, { url: string; keyEnv: string; extra?: Record<string, unknown> }> = {
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", keyEnv: "GROQ_API_KEY", extra: { include_reasoning: false, max_tokens: 4096 } },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GEMINI_API_KEY" },
};

export function isSelfModel(model: string): boolean {
  return model.split(":")[0] in BACKENDS && model.includes(":");
}

export function selfAccount(model: string) {
  const root = process.env.ATTESTER_PRIVATE_KEY ?? process.env.ARC_PRIVATE_KEY;
  if (!root) throw new Error("ATTESTER_PRIVATE_KEY (or ARC_PRIVATE_KEY) is not set");
  return privateKeyToAccount(keccak256(concat([root as Hex, toHex(model)])));
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
  const b = BACKENDS[backend]!;
  const key = process.env[b.keyEnv];
  if (!key) throw new Error(`${b.keyEnv} is not set (needed for ${model})`);
  const reqBody = new TextEncoder().encode(JSON.stringify({ ...body, ...b.extra, model: rest.join(":") }));
  let res: Response, respBody: Uint8Array, text: string;
  for (let wait = 0; ; wait++) {
    res = await fetch(b.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: reqBody,
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
