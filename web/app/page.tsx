import Link from "next/link";
import { LiveStats } from "@/components/live-stats";
import { SellerBoard } from "@/components/seller-board";
import { Badge, Card, Container, Kicker, SectionTitle } from "@/components/ui";

const STEPS = [
  {
    n: "01",
    title: "Pay with one gasless signature",
    body: "The agent signs a USDC ReceiveWithAuthorization. Its nonce is the hash of the terms: price, seller, rubric, judge policy and the seller's agent id. Change any term and USDC rejects it.",
    tag: "EIP-3009",
    color: "bg-yellow",
  },
  {
    n: "02",
    title: "The seller signs what it served",
    body: "The response comes back with an EIP-712 receipt over the exact request and response bytes. Two different receipts for one purchase prove the seller cheated.",
    tag: "EIP-712",
    color: "bg-blue",
  },
  {
    n: "03",
    title: "Two models judge, the contract checks",
    body: "Two different LLMs, a grounding check and a calibration pass each sign their verdict. AssayOracle re-hashes every byte with sha256 and recovers each signer with ecrecover.",
    tag: "on-chain",
    color: "bg-green",
  },
  {
    n: "04",
    title: "Paid or refunded, automatically",
    body: "A verified YES pays the seller. NO, a judge-injection attempt, swapped evidence or a missed deadline refunds the agent. No one holds the money in between.",
    tag: "USDC",
    color: "bg-pink",
  },
  {
    n: "05",
    title: "The verdict becomes a track record",
    body: "Each judged sale lands in the seller's ERC-8004 validation record (100 or 0). The next agent reads it before it buys, with no reviews to trust.",
    tag: "ERC-8004",
    color: "bg-lavender",
  },
];

const WHY = [
  ["Circle USDC on Fuji supports receiveWithAuthorization", "Only the escrow contract can redeem the agent's signature, so locking funds is gasless and nobody can front-run it."],
  ["ERC-8004 registries are already live on Fuji", "Verdicts land in the same identity and validation standard other Avalanche agents already read."],
  ["Finality in about a second", "The seller waits for the escrow to be locked before it serves, and the agent never waits for a block."],
  ["Gas cheap enough to verify every sale", "A ~2M-gas on-chain check of four signed model transcripts costs a fraction of a cent on Fuji, and about 0.005 AVAX on mainnet."],
];

export default function Home() {
  return (
    <>
      {/* hero */}
      <section className="border-b-[3px] border-black">
        <Container className="grid items-center gap-12 py-14 md:grid-cols-[1.25fr_1fr] md:py-20">
          <div>
            <div className="flex flex-wrap gap-2">
              <Kicker>x402 · Avalanche</Kicker>
              <Kicker className="bg-lavender">ERC-8004</Kicker>
            </div>
            <h1 className="mt-6 font-display text-5xl font-extrabold leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
              Agents only pay for work that <span className="bg-yellow px-2 shadow-nb-sm">passes.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed">
              Assay is a new x402 payment option. The agent's USDC is held until two LLM judges check the response
              against the seller's promise. The contract then verifies their signed verdicts itself and pays or refunds.
              Every outcome becomes the seller's verifiable ERC-8004 track record.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link href="/live" className="nb-btn">Watch it live</Link>
              <Link href="/try" className="nb-btn bg-pink">Run a purchase</Link>
              <Link href="/protocol" className="nb-btn bg-card">Read the protocol</Link>
            </div>
          </div>

          <div className="relative">
            <div className="nb-card rotate-1 bg-card p-5 shadow-nb-xl">
              <div className="flex items-center justify-between border-b-[3px] border-black pb-3">
                <span className="font-mono text-sm font-bold">HTTP 402 Payment Required</span>
                <Badge className="bg-orange">x402 v2</Badge>
              </div>
              <div className="mt-4 space-y-3">
                <div className="border-[3px] border-black bg-paper p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-bold">scheme: exact</span>
                    <span className="font-mono text-xs">0.25 USDC</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">Final. If the answer is junk, the money is gone.</p>
                </div>
                <div className="border-[3px] border-black bg-green p-3 shadow-nb-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-bold">scheme: assay</span>
                    <span className="font-mono text-xs">0.25 USDC</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] leading-snug">
                    rubric: &quot;Exactly 5 bullets. Every bullet is supported by the source.&quot;
                    <br />policy: 2 judges agree · grounded · conf ≥ 0.85
                    <br />agentId: #296 · record 100/100
                  </p>
                </div>
              </div>
            </div>
            <div className="nb-card absolute -bottom-14 -left-2 -rotate-3 bg-yellow px-4 py-3 sm:-left-8">
              <div className="font-mono text-xs font-bold">VERDICT:Y;CONF:0.95;RUBRIC:0x…;EVID:0x…;</div>
              <div className="mt-1 text-xs">sha256 + ecrecover, checked on-chain</div>
            </div>
          </div>
        </Container>
      </section>

      {/* marquee */}
      <div className="overflow-hidden border-b-[3px] border-black bg-black py-3 text-paper">
        <div className="nb-marquee flex w-max gap-10 whitespace-nowrap font-mono text-sm font-bold uppercase">
          {Array.from({ length: 2 }).map((_, k) => (
            <div key={k} className="flex gap-10">
              {["gasless for agents", "EIP-3009 receiveWithAuthorization", "terms hash = nonce", "seller-signed receipts", "equivocation proofs", "2 LLM judges + grounding + calibration", "sha256 + ecrecover on-chain", "ERC-8004 validation records", "Avalanche Fuji"].map((t) => (
                <span key={t} className="flex items-center gap-10">{t}<span className="text-yellow">✦</span></span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* live stats */}
      <section className="py-14">
        <Container>
          <SectionTitle kicker="Live on Avalanche Fuji" kickerClass="bg-green" title="Every purchase below was judged and settled on-chain." />
          <LiveStats />
        </Container>
      </section>

      {/* problem */}
      <section className="border-y-[3px] border-black bg-blue/30 py-16">
        <Container>
          <SectionTitle
            kicker="The problem"
            kickerClass="bg-pink"
            title={<>x402 payments are final. Agents pay first and hope.</>}
            sub="An agent pays before it sees the response. If the response is empty, invented or not what was promised, the payment is gone. Seller reputation today is whatever the seller claims about itself."
          />
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="bg-card p-6">
              <Badge className="bg-paper">scheme: exact</Badge>
              <ul className="mt-4 space-y-2 text-sm">
                <li>✗ Pays before seeing the work</li>
                <li>✗ No recourse for junk or invented facts</li>
                <li>✗ Reputation is self-reported</li>
                <li>✓ Cheap and simple, so it's still right for calls under a dollar</li>
              </ul>
            </Card>
            <Card className="bg-green p-6">
              <Badge className="bg-card">scheme: assay</Badge>
              <ul className="mt-4 space-y-2 text-sm font-medium">
                <li>✓ USDC is held until the work is verified</li>
                <li>✓ Judged against the seller&apos;s own promise, from the exact bytes served</li>
                <li>✓ The contract checks the judges&apos; signatures itself, with no oracle to trust</li>
                <li>✓ Every verdict builds a public ERC-8004 record</li>
              </ul>
            </Card>
          </div>
        </Container>
      </section>

      {/* how */}
      <section className="py-16">
        <Container>
          <SectionTitle kicker="How it works" title="One signature in. A verified outcome out." />
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s) => (
              <Card key={s.n} hover className="flex flex-col p-6">
                <div className="flex items-center justify-between">
                  <span className={`grid h-12 w-12 place-items-center border-[3px] border-black font-display text-xl font-extrabold ${s.color}`}>{s.n}</span>
                  <Badge className="bg-paper">{s.tag}</Badge>
                </div>
                <h3 className="mt-5 font-heading text-xl font-bold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed">{s.body}</p>
              </Card>
            ))}
            <Card className="flex flex-col justify-between bg-yellow p-6">
              <h3 className="font-heading text-xl font-bold">Sellers need no gas. Agents need no AVAX.</h3>
              <p className="mt-2 text-sm">
                The Assay node acts as the x402 facilitator and keeper. It can&apos;t move money anywhere the agent
                didn&apos;t sign for, and every step is permissionless on-chain.
              </p>
              <Link href="/protocol" className="nb-btn nb-btn-sm mt-4 self-start bg-card">See the wire format →</Link>
            </Card>
          </div>
        </Container>
      </section>

      {/* sellers */}
      <section className="border-y-[3px] border-black bg-lavender/40 py-16">
        <Container>
          <SectionTitle
            kicker="The demo"
            kickerClass="bg-orange"
            title="Four sellers. One promise. Their verified records."
            sub="All four sell the same 5-bullet summary under the same rubric. Only one keeps the promise, and the chain remembers."
          />
          <SellerBoard compact />
          <div className="mt-8 flex flex-wrap gap-4">
            <Link href="/sellers" className="nb-btn bg-card">Full leaderboard</Link>
            <Link href="/try" className="nb-btn bg-pink">Buy from one yourself</Link>
          </div>
        </Container>
      </section>

      {/* why avalanche */}
      <section className="py-16">
        <Container>
          <SectionTitle kicker="Why Avalanche" kickerClass="bg-pink" title="Built on things only a fast, cheap, standards-ready chain gives you." />
          <div className="grid gap-5 md:grid-cols-2">
            {WHY.map(([t, b], i) => (
              <Card key={t} className={`p-6 ${["bg-card", "bg-yellow", "bg-card", "bg-green"][i]}`}>
                <h3 className="font-heading text-lg font-bold">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed">{b}</p>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* trust */}
      <section className="py-4">
        <Container>
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="bg-card p-6">
              <Kicker className="bg-green">The contract guarantees</Kicker>
              <ul className="mt-4 space-y-2 text-sm">
                <li>✓ Every verdict&apos;s bytes hash to what a registered judge key signed</li>
                <li>✓ The judges saw this purchase&apos;s rubric and evidence hashes</li>
                <li>✓ Distinct models agreed, the claims were grounded, confidence ≥ the floor</li>
                <li>✓ The evidence is what the seller signed. Swapping it refunds the buyer</li>
                <li>✓ A record can only land on the agent identity the buyer paid</li>
              </ul>
            </Card>
            <Card className="bg-orange p-6">
              <Kicker className="bg-card">What we trust (said plainly)</Kicker>
              <ul className="mt-4 space-y-2 text-sm">
                <li>• Demo judges are self-attested: the node holds their signing keys. TEE-signed judges plug into the same oracle unchanged.</li>
                <li>• The SignerRegistry owner decides which judge keys count. Every change is a public event.</li>
                <li>• Judges check the response against the source, not facts in the real world.</li>
                <li>• A seller could pay itself to farm a good record. That shows up on-chain, and filtering it is on the roadmap.</li>
              </ul>
            </Card>
          </div>
        </Container>
      </section>

      {/* cta */}
      <section className="pt-16">
        <Container>
          <div className="nb-card flex flex-col items-start justify-between gap-6 bg-black p-8 text-paper shadow-nb-xl md:flex-row md:items-center">
            <div>
              <h2 className="font-display text-3xl font-extrabold sm:text-4xl">See a judged purchase settle on Fuji.</h2>
              <p className="mt-2 text-paper/80">Pick a seller, pay once, and watch the verdict reach Snowtrace.</p>
            </div>
            <Link href="/try" className="nb-btn shrink-0 border-paper">Run a purchase →</Link>
          </div>
        </Container>
      </section>
    </>
  );
}
