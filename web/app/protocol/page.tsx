import { Badge, Card, Container, Kicker, SectionTitle } from "@/components/ui";

export const metadata = { title: "Protocol · Countersign" };

function Code({ children, title }: { children: string; title?: string }) {
  return (
    <div>
      {title && <div className="inline-block border-[3px] border-b-0 border-black bg-yellow px-3 py-1 font-mono text-xs font-bold">{title}</div>}
      <pre className="nb-code whitespace-pre">{children}</pre>
    </div>
  );
}

const OFFER = `{
  "scheme": "countersign",
  "network": "eip155:43113",
  "asset": "0x5425890298aed601595a70AB815c96711a31Bc65",   // Circle USDC (Fuji)
  "amount": "250000",                                       // 0.25 USDC
  "payTo": "0x<seller>",                                    // becomes escrow.payee
  "maxTimeoutSeconds": 120,
  "extra": {
    "name": "USD Coin", "version": "2",                     // USDC EIP-712 domain
    "escrow": "0x<CountersignEscrow>",
    "rubric": "Exactly 5 bullets. Every bullet is supported by …",
    "policy": { "judges": 2, "minAgree": 2, "minConfBps": 8500, "requireGrounded": true },
    "deadlineSeconds": 900,
    "arbiter": "0x0000000000000000000000000000000000000000",
    "agentId": "296",                                       // seller's ERC-8004 identity
    "validator": "0x<CountersignValidator>",
    "identityRegistry": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    "validationRegistry": "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    "facilitator": "https://<countersign-node>",
    "evidence": { "format": "countersign-evidence-v1", "maxRequestBytes": 3000, "maxResponseBytes": 2000 }
  }
}`;

const PAYLOAD = `{
  "x402Version": 2,
  "accepted": { …the offer above… },
  "payload": {
    "authorization": {
      "from": "0x<agent>", "to": "0x<CountersignEscrow>", "value": "250000",
      "validAfter": "<now-60>", "validBefore": "<now+120>",
      "nonce": "0x<termsHash(...)>"         // the terms ARE the nonce
    },
    "signature": "0x<EIP-712 ReceiveWithAuthorization>",
    "salt": "0x<32 random bytes>",
    "deadline": "<now + deadlineSeconds>"
  }
}`;

const TERMS = `bytes32 TERMS_TAG = keccak256("countersign.terms.v1");

termsHash = keccak256(abi.encode(
  TERMS_TAG, block.chainid, address(escrow),
  payee, arbiter, amount, deadline, keccak256(rubric),
  policy, agentId, salt
));

escrowId = keccak256(abi.encode(payer, termsHash));

// CountersignEscrow.openWithAuthorization:
usdc.receiveWithAuthorization(payer, address(this), amount,
                              validAfter, validBefore, termsHash, v, r, s);
// USDC requires msg.sender == to  -> only the escrow can redeem it (no front-running)
// any changed term -> different nonce -> USDC signature check fails`;

const EVIDENCE = `COUNTERSIGN-EVIDENCE v1
REQUEST POST /honest/summarize
{"document":"The Pune Municipal Corporation has …","bullets":5}

RESPONSE 200
{"bullets":["…","…","…","…","…"]}

evidenceHash = keccak256(utf8 bytes)     // UTF-8, LF, no trailing newline`;

const RECEIPT = `domain  = { name: "CountersignEscrow", version: "1", chainId, verifyingContract: escrow }
Receipt(bytes32 escrowId, bytes32 evidenceHash)

setEvidenceWithReceipt(id, evidenceHash, uri, sellerSig)   // anyone can submit it
proveEquivocation(id, otherHash, sellerSig)                // 2 signed hashes -> refund`;

const HEADER = `VERDICT:Y;CONF:0.93;RUBRIC:0x<64 hex>;EVID:0x<64 hex>;<rationale>
^0      ^8 ^10   ^15  ^20     ^27      ^93  ^99        ^165

signed text = hex(sha256(requestBytes)) ":" hex(sha256(responseBytes))   // EIP-191`;

const SELLER = `import { countersignRoute } from "@countersign/x402";

const route = countersignRoute({
  chainId: 43113, usdc, escrow, seller: privateKeyToAccount(KEY),
  price: 250_000n,
  rubric: "Exactly 5 bullets. Every bullet is supported by …",
  policy: { judges: 2, minAgree: 2, minConfBps: 8500, requireGrounded: true },
  agentId: 296n, validator, identityRegistry, validationRegistry,
  facilitator: "https://<countersign-node>",
  handler: async ({ body }) => Response.json(await summarize(body)),
});
Bun.serve({ fetch: route });`;

const BUYER = `import { fetchWithCountersign } from "@countersign/x402";

const p = await fetchWithCountersign(url, { method: "POST", body }, {
  account, publicClient, prefer: "countersign", maxAmount: 1_000_000n,
  minTrust: { minCount: 3, minAvg: 80, requireSelfFiling: true },  // ERC-8004
});
const final = await p.watch();   // Resolved (seller paid) | Refunded`;

const FUNCS: [string, string, string][] = [
  ["openWithAuthorization(auth, rubric, policy)", "anyone", "Locks USDC from the buyer's EIP-3009 signature; terms = nonce"],
  ["setEvidenceWithReceipt(id, hash, uri, sig)", "anyone", "Commits evidence only with the seller's EIP-712 receipt"],
  ["proveEquivocation(id, otherHash, sig)", "anyone", "Two signed evidence hashes → buyer refunded, reason Equivocation"],
  ["settle(id, judges, grounding, calibration, ids)", "anyone", "Oracle verifies every signature on-chain → pay, refund or escalate"],
  ["arbitrate(id, release)", "arbiter", "Human fallback for escalations (optional)"],
  ["refundAfterDeadline(id)", "anyone", "No verdict by the deadline → buyer refunded"],
  ["CountersignValidator.record(id)", "anyone", "Writes the ERC-8004 validation response: YES 100, NO / equivocation 0"],
];

const THREATS: [string, string][] = [
  ["Forge or edit a verdict", "ecrecover against SignerRegistry over sha256 of the exact bytes. One changed byte gives a stranger's address."],
  ["Replay a verdict from another purchase", "The request must contain this escrow's rubric and evidence hashes, and the header must match the stored hashes."],
  ["Prompt-inject the judge", "Evidence is fenced as untrusted, a grounding check runs, two model families must agree, and there is a confidence floor. Otherwise the purchase escalates."],
  ["Front-run or alter the payment", "receiveWithAuthorization only accepts msg.sender == escrow, and the nonce is the terms hash."],
  ["Serve A, commit B", "The buyer holds a signed receipt for A, so proveEquivocation refunds the buyer and the seller's record takes a 0."],
  ["Withhold the evidence", "Anyone can submit it with the seller's receipt, or the buyer is refunded at the deadline."],
  ["Hide failed sales", "The seller approves CountersignValidator once, so anyone can record every judged sale. Buyers check the approval."],
  ["Steal someone's record", "The agent id is signed into the terms, ownerOf(agentId) must equal the payee, and there is one record per purchase."],
  ["Keeper goes down", "Every function is permissionless, and the buyer is refunded after the deadline."],
];

export default function ProtocolPage() {
  return (
    <Container className="py-12">
      <SectionTitle
        kicker="Protocol"
        kickerClass="bg-blue"
        title={<>The <code className="bg-yellow px-2">countersign</code> x402 scheme</>}
        sub="A new x402 payment option for Avalanche. Sellers list it next to exact. Clients that don't know it still see exact first."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Code title="402 · PAYMENT-REQUIRED (accepts[1])">{OFFER}</Code>
        <Code title="retry · PAYMENT-SIGNATURE">{PAYLOAD}</Code>
      </div>

      <section className="mt-14 grid gap-6 lg:grid-cols-2">
        <div>
          <Kicker className="bg-green">1 · Terms locked into the nonce</Kicker>
          <p className="mt-3 text-sm leading-relaxed">
            Circle USDC on Fuji implements EIP-3009 <code className="font-mono">receiveWithAuthorization</code>. The agent never sends a
            transaction and never needs AVAX. Whoever submits the open can&apos;t change a single term.
          </p>
          <div className="mt-4"><Code>{TERMS}</Code></div>
        </div>
        <div>
          <Kicker className="bg-pink">2 · Evidence and receipts</Kicker>
          <p className="mt-3 text-sm leading-relaxed">
            The seller signs the exact bytes it served. The buyer rebuilds the same evidence from what it sent and received
            and checks the receipt before it trusts anything.
          </p>
          <div className="mt-4 space-y-4"><Code>{EVIDENCE}</Code><Code>{RECEIPT}</Code></div>
        </div>
      </section>

      <section className="mt-14">
        <Kicker className="bg-lavender">3 · Verdicts the contract can check</Kicker>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed">
          Each judge reply starts with a fixed-width 166-byte header that the oracle parses by byte offset, with no JSON on-chain.
          The judge key signs the sha256 of the exact request and response bytes, the layout TEE inference gateways use, so
          enclave-signed judges plug in without changing the contract.
        </p>
        <div className="mt-4"><Code>{HEADER}</Code></div>
      </section>

      <section className="mt-14">
        <Kicker>4 · Contract surface</Kicker>
        <div className="mt-4 overflow-x-auto">
          <table className="nb-card w-full min-w-[640px] border-collapse bg-card text-left text-sm">
            <thead className="bg-black text-paper">
              <tr><th className="p-3 font-heading">Function</th><th className="p-3 font-heading">Who</th><th className="p-3 font-heading">Effect</th></tr>
            </thead>
            <tbody>
              {FUNCS.map(([f, w, e]) => (
                <tr key={f} className="border-t-[3px] border-black">
                  <td className="p-3 font-mono text-xs">{f}</td>
                  <td className="p-3"><Badge className={w === "anyone" ? "bg-green" : "bg-orange"}>{w}</Badge></td>
                  <td className="p-3">{e}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-14">
        <Kicker className="bg-orange">5 · Threat model</Kicker>
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {THREATS.map(([t, d]) => (
            <Card key={t} className="bg-card p-4">
              <h4 className="font-heading font-bold">{t}</h4>
              <p className="mt-1.5 text-sm">{d}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-14 grid gap-6 lg:grid-cols-2">
        <div>
          <Kicker className="bg-blue">6 · Sell with it</Kicker>
          <div className="mt-4"><Code title="seller.ts">{SELLER}</Code></div>
        </div>
        <div>
          <Kicker className="bg-green">7 · Buy with it</Kicker>
          <div className="mt-4"><Code title="agent.ts">{BUYER}</Code></div>
          <Card className="mt-6 bg-yellow p-4 text-sm">
            <b>Facilitator endpoints</b> (countersign node): <code className="font-mono">POST /facilitator/verify</code>, <code className="font-mono">POST /facilitator/settle</code>,{" "}
            <code className="font-mono">GET /facilitator/supported</code>, <code className="font-mono">POST /evidence</code>. Paid judge-as-a-service:{" "}
            <code className="font-mono">POST /judge</code> (x402 exact).
          </Card>
        </div>
      </section>
    </Container>
  );
}
