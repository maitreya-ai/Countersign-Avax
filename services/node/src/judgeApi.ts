// Judge-as-a-service over x402 `exact`: POST /judge { rubric, evidence } -> 402 until paid, then a
// signed verdict bundle any AssayEscrow can verify, plus settle calldata (swap in your escrow id).

import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { CORS_HEADERS, HEADERS, decodeHeader, encodeHeader, escrowAbi, type ExactPayload, type PaymentRequirements } from "@assay/x402";
import { cfg, keeper } from "./ctx";
import { buildBundle, registerSignersFor, settleArgs } from "./judgeKit";
import { facilitatorSettle, facilitatorVerify } from "./facilitator";

function requirements(resource: string): PaymentRequirements {
  return {
    scheme: "exact", network: cfg.network, asset: cfg.usdc, amount: cfg.judgePrice.toString(), payTo: keeper.account.address,
    maxTimeoutSeconds: 600, resource, description: "One signed verdict bundle (2 judges + grounding + calibration) for AssayEscrow.settle",
    mimeType: "application/json", extra: { name: "USD Coin", version: "2" },
  };
}

export async function judgeRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const reqs = requirements(`${cfg.publicUrl}${url.pathname}`);
  const sig = req.headers.get(HEADERS.signature) ?? req.headers.get("X-PAYMENT");
  if (!sig) {
    const body = { x402Version: 2, accepts: [reqs], error: "Payment required" };
    return Response.json(body, { status: 402, headers: { ...CORS_HEADERS, [HEADERS.required]: encodeHeader(body) } });
  }
  let payment: ExactPayload;
  try { payment = decodeHeader(sig); } catch { return Response.json({ error: "bad PAYMENT-SIGNATURE" }, { status: 400, headers: CORS_HEADERS }); }
  const v = await facilitatorVerify({ x402Version: 2, paymentPayload: payment, paymentRequirements: reqs });
  if (!v.isValid) return Response.json({ error: "payment invalid", detail: v }, { status: 402, headers: CORS_HEADERS });

  const body = (await req.json().catch(() => ({}))) as { rubric?: string; evidence?: string };
  if (!body.rubric || !body.evidence) return Response.json({ error: "rubric and evidence required" }, { status: 400, headers: CORS_HEADERS });
  const c = { rubric: body.rubric, evidence: body.evidence, rubricHash: keccak256(toHex(body.rubric)), evidenceHash: keccak256(toHex(body.evidence)) };
  const bundle = await buildBundle(c, () => {});
  await registerSignersFor(bundle);

  const settled = await facilitatorSettle({ x402Version: 2, paymentPayload: payment, paymentRequirements: reqs });
  if (!settled.success) return Response.json({ error: "payment settlement failed", detail: settled }, { status: 402, headers: CORS_HEADERS });

  const sa = settleArgs(bundle);
  const settleCalldata = encodeFunctionData({
    abi: escrowAbi, functionName: "settle",
    args: [`0x${"00".repeat(32)}` as Hex, sa.judges, sa.grounding, sa.calibration, sa.requestIds],
  });
  return Response.json(
    { rubricHash: c.rubricHash, evidenceHash: c.evidenceHash, attestations: [...sa.judges, sa.grounding, sa.calibration], requestIds: sa.requestIds, settleCalldata, payment: settled },
    { headers: { ...CORS_HEADERS, [HEADERS.response]: encodeHeader(settled) } },
  );
}
