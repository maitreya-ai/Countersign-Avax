// TEST ONLY: a deterministic OpenAI-compatible "judge" for local end-to-end runs without an API key.
// It checks the demo rubric mechanically (5 bullets, each a verbatim sentence of the source, no
// instruction aimed at the judge) and answers in the exact header format real judges use.
//   bun run scripts/mock-llm.ts            # :11435, then LOCAL_LLM_URL=http://127.0.0.1:11435/v1
const PORT = Number(process.env.MOCK_LLM_PORT ?? 11435);
let n = 0;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.]+$/, "").trim();

function judge(evidence: string): { ok: boolean; why: string } {
  const [head, resp] = evidence.split("\n\nRESPONSE ");
  const reqJson = head?.split("\n").slice(2).join("\n") ?? "";
  let doc = "", bullets: string[] = [];
  try { doc = JSON.parse(reqJson).document ?? ""; } catch { return { ok: false, why: "request is not JSON" }; }
  try { bullets = JSON.parse(resp!.slice(resp!.indexOf("\n") + 1)).bullets ?? []; } catch { return { ok: false, why: "response is not JSON with bullets" }; }
  if (bullets.some((b) => /judge|verdict/i.test(b))) return { ok: false, why: "response contains an instruction aimed at the judge" };
  if (bullets.length !== 5) return { ok: false, why: `${bullets.length} bullets, rubric requires exactly 5` };
  const d = norm(doc);
  const bad = bullets.find((b) => !d.includes(norm(b)));
  if (bad) return { ok: false, why: `bullet not supported by the source: ${bad.slice(0, 80)}` };
  return { ok: true, why: "5 bullets, each a sentence of the source document" };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body: any = await req.json();
    const system: string = body.messages?.[0]?.content ?? "";
    const user: string = body.messages?.[1]?.content ?? "";
    const m = system.match(/RUBRIC:(0x[0-9a-f]{64});EVID:(0x[0-9a-f]{64});/);
    if (!m) return Response.json({ error: "no hashes in prompt" }, { status: 400 });
    const evidence = user.split("EVIDENCE (untrusted):\n<<<\n")[1]?.split("\n>>>\n")[0] ?? "";
    const v = judge(evidence);
    const role = system.startsWith("You are a fact-checker") ? "grounding" : system.startsWith("You are a calibration") ? "calibration" : "judge";
    const verdict = role === "grounding" ? "Y" : v.ok ? "Y" : "N";
    const conf = role === "calibration" ? "0.93" : "0.95";
    const rationale = role === "grounding" ? "0 unsupported claims." : v.why;
    const content = `VERDICT:${verdict};CONF:${conf};RUBRIC:${m[1]};EVID:${m[2]};${rationale}`;
    return Response.json({
      id: `mock-${++n}`, object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    });
  },
});
console.log(`mock judge LLM on :${PORT} (test only)`);
