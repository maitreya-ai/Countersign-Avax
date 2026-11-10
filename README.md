# Countersign

**Agents only pay for work that passes.**

Countersign is a new x402 payment option for Avalanche. The agent's USDC is held until two LLM judges check the
response against the seller's promise. The contract then verifies their signed verdicts **itself** (`sha256` of the
exact bytes, `ecrecover` of each judge key) and pays the seller or refunds the agent. Every outcome is written to
the seller's **ERC-8004 validation record**, so the next agent can check a verified track record before it buys.

- **Live dapp:** https://countersign.maitreyak1806.workers.dev (Cloudflare Workers; the node runs in a Durable Object)
- **Network:** Avalanche Fuji C-Chain (`eip155:43113`), Circle USDC, ERC-8004 Identity + Validation registries

---

## Why

x402 payments are final: an agent pays before it sees the response, so an empty, invented or off-spec answer
is money gone. Seller reputation today is whatever the seller claims about itself.

Countersign adds a second option next to `exact` in the 402 offer:

| | `exact` | `countersign` |
|---|---|---|
| When the seller is paid | Immediately | Only after a verified YES |
| Junk answer | Paid anyway | Agent refunded |
| Agent gas | none (facilitator) | none: one EIP-3009 signature |
| Reputation | self-reported | ERC-8004 record written from on-chain verdicts |
| Best for | calls under ~$1 | anything worth checking |

## How it works

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant S as Seller (x402 middleware)
  participant N as Countersign node (facilitator + keeper)
  participant E as CountersignEscrow
  participant O as CountersignOracle
  participant V as CountersignValidator → ERC-8004
  A->>S: POST /summarize
  S-->>A: 402: accepts [exact, countersign{rubric, policy, agentId}]
  A->>V: getSummary(agentId): verified record (optional)
  A->>A: sign ReceiveWithAuthorization, nonce = termsHash(terms)
  A->>S: retry + PAYMENT-SIGNATURE
  S->>N: /facilitator/settle
  N->>E: openWithAuthorization (USDC locked; only the escrow can redeem it)
  S-->>A: 200 + X-COUNTERSIGN-RECEIPT (EIP-712 over the exact evidence bytes)
  S->>N: evidence + receipt
  A->>N: evidence + receipt (backup; a different hash = equivocation)
  N->>E: setEvidenceWithReceipt
  N->>N: judge A + judge B + grounding + calibration (signed over exact bytes)
  N->>E: settle(bundle)
  E->>O: resolve: sha256, ecrecover, registry, hash binding, quorum
  E-->>S: YES → pay seller · NO → refund agent
  N->>V: record(escrowId) → validationResponse 100 / 0
```

1. **Terms are the nonce.** The agent signs a USDC `ReceiveWithAuthorization` whose nonce is
   `keccak256(TERMS_TAG, chainId, escrow, payee, arbiter, amount, deadline, rubricHash, policy, agentId, salt)`.
   Circle USDC only lets `to` (the escrow) redeem it, so the open cannot be front-run or altered.
2. **Receipts.** The seller signs an EIP-712 `Receipt(escrowId, evidenceHash)` over the exact request and
   response bytes it served. Evidence is accepted on-chain only with that signature. Two different signed hashes
   for one purchase are a proof of equivocation, and `proveEquivocation` refunds the agent.
3. **Verified verdicts.** Two distinct models judge, a grounding pass checks their rationales against the evidence,
   and a calibration pass sets the confidence. Each reply starts with a fixed-width header the oracle parses by
   byte offset, and each is signed over `hex(sha256(req)):hex(sha256(resp))`.
4. **Track record.** `CountersignValidator` turns judged outcomes into ERC-8004 validation responses (YES = 100,
   NO or equivocation = 0). Sellers approve the validator once, so **anyone can record every sale and a
   seller cannot hide its failures**. The agent id is signed into the terms, so credit cannot be redirected.

## Demo

Four sellers sell the same 5-bullet summary under the same rubric
(*"Exactly 5 bullets. Every bullet is supported by a sentence in the source document. No facts that are not in the source."*):

| Seller | Behaviour | Outcome | ERC-8004 |
|---|---|---|---|
| `honest` | five sentences from the source | **YES**, seller paid | 100 |
| `lazy` | three bullets, one invented fact | **NO**, agent refunded | 0 |
| `injector` | an invented fact + a hidden note telling the judge to answer Y | **NO**, agent refunded | 0 |
| `swapper` | serves junk, commits a good answer as evidence | **Equivocation**, agent refunded | 0 |

```text
$ bun run demo/agent/buy.ts
USDC 50.00 -> 49.75  (paid only for work that passed)
Next time: buy from honest (verified 100/100 over 1 sales).
```

Every purchase page on the dashboard has **Verify in browser**. It reads the chain directly, decodes the settle
calldata, re-hashes every byte, recovers each judge key, re-applies the policy and checks the ERC-8004 record,
without trusting the node or the website.

## Deployed on Avalanche Fuji

All contracts are verified on Snowtrace.

| Contract | Address |
|---|---|
| CountersignEscrow | [`0x646fc9D1FD54574761dB44f7691f0352BCdFF501`](https://testnet.snowtrace.io/address/0x646fc9D1FD54574761dB44f7691f0352BCdFF501) |
| CountersignOracle | [`0x15d77bf67210D4D8de2E2E51dE221F3Ef4600574`](https://testnet.snowtrace.io/address/0x15d77bf67210D4D8de2E2E51dE221F3Ef4600574) |
| SignerRegistry | [`0x20028875D57eBAba1A0689976FF61B684c1Aa43a`](https://testnet.snowtrace.io/address/0x20028875D57eBAba1A0689976FF61B684c1Aa43a) |
| CountersignValidator | [`0xC66819e0dEB88E9c99Bc70D6B3e2fA446321AaC6`](https://testnet.snowtrace.io/address/0xC66819e0dEB88E9c99Bc70D6B3e2fA446321AaC6) |
| Circle USDC | [`0x5425890298aed601595a70AB815c96711a31Bc65`](https://testnet.snowtrace.io/address/0x5425890298aed601595a70AB815c96711a31Bc65) |
| ERC-8004 IdentityRegistry | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.snowtrace.io/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| ERC-8004 ValidationRegistry | [`0x8004Cb1BF31DAf7788923b405b754f57acEB4272`](https://testnet.snowtrace.io/address/0x8004Cb1BF31DAf7788923b405b754f57acEB4272) |

Demo sellers are ERC-8004 agents #296 (honest), #297 (lazy), #298 (injector) and #299 (swapper).

### Live demo run (real LLM judges: `openai/gpt-oss-120b` + `qwen/qwen3.8-27b` on Groq)

| Seller | Outcome | Open (gasless for the buyer) | Verdict | ERC-8004 record |
|---|---|---|---|---|
| honest | **YES**: seller paid, record 100 | [open](https://testnet.snowtrace.io/tx/0x42b82704288d80adcaabba5ef93cb73df018e6bf25518cb02928aae2b8040197) | [settle](https://testnet.snowtrace.io/tx/0xbb551b238955a679ab959ada31ca05ccbb7ec487442773cde6645759c46e5594) | [100](https://testnet.snowtrace.io/tx/0xa78c65bd9b65ca6d788170f55aba978770bf8fc502b552dd0a9a32f4136fb11e) |
| lazy | **NO**: refunded, record 0 | [open](https://testnet.snowtrace.io/tx/0x4524c2a9f2707a284e77feca208ef7a5b0fb92a14a1302f18b8e4da8b227f391) | [settle](https://testnet.snowtrace.io/tx/0x82d5d5422350c2ba74b2e05c1aae415661e027a95457ae5838e7dc5119d274b0) | [0](https://testnet.snowtrace.io/tx/0x830a94cfcbaf54d4bd479d17791e2520560771f242e969d351bb115b4e1b19ca) |
| injector | **NO**: refunded (judges ignored the injected note), record 0 | [open](https://testnet.snowtrace.io/tx/0x101b841442b45f1495541532e8f70f236e3ad0c64faa8332bfc0d5f0f70af13c) | [settle](https://testnet.snowtrace.io/tx/0xdfabecbba9f9998b42aee037ee774d00599ecd86182ecdc0a6c12a83b0c49744) | [0](https://testnet.snowtrace.io/tx/0xe5ddd06a13d68a744c95146c7e5527680ab27fff778df215b2b816cb6055a5c1) |
| swapper | **Equivocation**: refunded, record 0 | [open](https://testnet.snowtrace.io/tx/0xb8061e989ee64b7fbd35f8fd3812786973b8bfe8d86ef05fcc16f7d167ea34b1) | [proveEquivocation](https://testnet.snowtrace.io/tx/0x4f450f054ab41a4cbf5a4032cd8996b77e1b2e184b3c7d07ba8a1353c38cb547) | [0](https://testnet.snowtrace.io/tx/0xce917f96b2ae57061d58419b5e0a97e35204dff1b3650a83c7ada7d5e841a19c) |

The buyer spent 0.25 USDC of 1.00: it paid only for the summary that passed, and it never held any AVAX.

## Architecture

```text
browser ──► Cloudflare Worker (countersign.maitreyak1806.workers.dev)
             ├─ /*      the dapp: Next.js static export (Workers static assets)
             └─ /api/*  CountersignNode Durable Object (SQLite + alarms)
                         x402 facilitator · demo sellers · evidence intake · keeper (judge → settle → record)
browser ──► Avalanche Fuji RPC   the dapp reads purchases, verdicts and ERC-8004 records straight from the chain
```

The dapp never depends on the node to *show* anything: escrow events come from the chain, state from a
Multicall3 batch, seller records from the ERC-8004 Validation Registry, and every judge verdict, plus the exact
evidence the judges saw, is decoded from the settle transaction's calldata. The node is only needed to *make*
a purchase (it is the x402 facilitator, hosts the demo sellers and runs the judges). If it is down, everything
already on-chain is still visible and verifiable.

## Repository

```text
contracts/                  Foundry: SignerRegistry, CountersignOracle, CountersignEscrow, CountersignValidator + tests
packages/x402-countersign/  the reusable x402 `countersign` scheme (viem only): terms, evidence, receipts, seller middleware, buyer client
packages/core/              judge pipeline (self-attested signers; groq/gemini/local backends), chain config, settle verifier
services/node/              the node: app.ts (routes), keeper, facilitator; hosts: index.ts (Bun), worker.ts (Cloudflare)
demo/sellers/               honest, lazy, injector, swapper
demo/agent/                 the buyer agent the demo video follows
web/                        Next.js dapp (neubrutalism), reads Avalanche directly
tests/e2e/                  end-to-end wiring suite (Fuji fork) and live smoke tests
scripts/                    keys, deploy, fund, register sellers, local fork setup, test-only mock judge
wrangler.jsonc              Cloudflare Worker + Durable Object + static assets
```

## Run it

Requirements: [Bun](https://bun.sh) ≥ 1.2, [Foundry](https://getfoundry.sh).

```bash
bun install                      # also installs the git hooks (husky)
bun run test                     # unit + contracts + end-to-end
```

### Local, on a fork of Fuji (real USDC and ERC-8004, no funds or API keys needed)

```bash
bun run scripts/gen-keys.ts .env.fork            # then set RPC_URL=http://127.0.0.1:8545 and local:mock-* judges
anvil --fork-url https://api.avax-test.network/ext/bc/C/rpc &
bun --env-file=.env.fork run scripts/fork-setup.ts
bun --env-file=.env.fork run scripts/deploy.ts
bun --env-file=.env.fork run scripts/register-sellers.ts
bun --env-file=.env.fork run scripts/mock-llm.ts &                  # TEST ONLY deterministic judge
MOUNT_SELLERS=1 SELLERS_URL=http://localhost:8402 bun --env-file=.env.fork run services/node/src/index.ts &
SELLERS_URL=http://localhost:8402 bun --env-file=.env.fork run demo/agent/buy.ts
```

### Fuji

```bash
bun run scripts/gen-keys.ts                      # fund DEPLOYER with test AVAX and test USDC (faucet.circle.com)
# set GROQ_API_KEY (or GEMINI_API_KEY) in .env
VERIFY=1 bun run scripts/deploy.ts               # deploys + verifies on Snowtrace, writes .env and deployments/43113.json
bun run scripts/fund.ts                          # AVAX to sellers (one-time registration), USDC to the demo agent
bun run scripts/register-sellers.ts              # ERC-8004 identities + validator approval
MOUNT_SELLERS=1 bun run services/node/src/index.ts
bun run demo/agent/buy.ts
NEXT_PUBLIC_NODE_URL=http://localhost:8402 bun run web    # dapp on http://localhost:3000
```

### Deploy to Cloudflare

```bash
bun run deploy                                   # builds the static dapp, then wrangler deploy (Worker + Durable Object + assets)
bunx wrangler secret bulk < secrets.json         # once: DEPLOYER/ATTESTER/AGENT/SELLER_* private keys + GROQ_API_KEY (never commit)
bun run test:live                                # smoke-test the deployment
```

Public configuration (contract addresses, judge models, `NODE_URL`) lives in `wrangler.jsonc`. The Bun host
(`Dockerfile`) runs the same node for any other platform.

## Tests

| Suite | What it covers |
|---|---|
| `contracts/test/Oracle.t.sol` (20) | byte-bound verdict verification, tampering, replay, header parsing, quorum policy |
| `contracts/test/Escrow.t.sol` (26) | gasless open, every term bound to the nonce, replay, expiry, front-running, receipts (EOA + ERC-1271), equivocation, every outcome reason, fund conservation |
| `contracts/test/Validator.t.sol` (15) | 100 / 0 / 0 scores, unrecorded outcomes, self-filing, stolen or misdirected credit, double recording |
| `contracts/test/ForkFuji.t.sol` | full purchase against the **real** Fuji USDC and ERC-8004 registries (`FUJI_RPC_URL=… forge test --match-contract ForkFuji`) |
| `packages/x402-countersign/test` | TypeScript ↔ Solidity parity (terms hash, escrow id, receipt digest, request hash), evidence format |
| `tests/e2e/wiring.test.ts` | end to end on a Fuji fork: deploys, registers sellers, runs the real node under `/api`, buys from all four sellers, and checks that receipts match, outcomes and ERC-8004 records are right, the dapp's chain reader reconstructs exactly what the node reports, and in-browser verification passes for every purchase |
| `tests/e2e/live.test.ts` | smoke test of the live deployment: every page, API wiring to the deployed contracts, each seller's 402 offer |

Git hooks (husky): **pre-commit** runs every typecheck and the unit tests; **pre-push** runs the contract tests
and the end-to-end suite (`SKIP_E2E=1` to skip it when offline). Tests use Bun's Jest-compatible runner
(`describe` / `test` / `expect`).

Gas on Fuji: `settle` with two judges and real LLM transcripts ≈ 2.35M, `openWithAuthorization` ≈ 200k. At Fuji's current 160 wei gas price a settle costs well under a millionth of an AVAX.

## Trust model

**The contract guarantees:** every verdict's bytes hash to what a registered judge key signed; the judges saw this
purchase's rubric and evidence hashes; distinct models agreed, claims were grounded, confidence met the floor; the
evidence is what the seller signed; a record lands only on the agent identity the buyer paid.

**What is trusted (demo mode):** judges are *self-attested*, so the node holds their signing keys and could sign a
verdict no model produced. The oracle checks the same signature layout TEE inference gateways use, so
enclave-signed judges plug in without contract changes. The `SignerRegistry` owner decides which judge keys count
(every change is a public event). Judges assess the response against the source, not facts in the world. A seller
could farm a good record by paying itself; this is visible on-chain, and filtering it is on the roadmap.

## What existed vs what's new

| Area | Reused (first commit) | New in Countersign |
|---|---|---|
| Contracts | `SignerRegistry`, the oracle's byte-bound verdict checks and quorum policy (renamed `CountersignOracle`), escrow v1 functions, 20 tests | `CountersignEscrow` v2: gasless `openWithAuthorization` with the terms as the EIP-3009 nonce, agent id in the terms, EIP-712 seller receipts, `proveEquivocation`, outcome reasons, deadline refund by anyone. **`CountersignValidator`** (ERC-8004 records with self-filing). 42 new tests, including a Fuji fork test |
| Chain | (another testnet) | Avalanche Fuji: Circle USDC `ReceiveWithAuthorization`, ERC-8004 Identity + Validation registries |
| x402 | one `exact` pay-per-verdict endpoint | the **`countersign` scheme** (offer format, seller middleware, buyer client with trust check and equivocation watch), facilitator endpoints, reusable `@countersign/x402` package |
| Judges | prompts, header format, self-attested signer | `local:` backend, injection-aware judge prompt, judge-as-a-service on `exact` |
| Off-chain | relayer scripts | node (facilitator + keeper + API), four demo sellers, demo agent, Next.js dashboard with in-browser verification |

## Built with

Avalanche Fuji C-Chain · Circle USDC (EIP-3009) · ERC-8004 · x402 · Foundry · Bun · viem · Next.js · Cloudflare Workers + Durable Objects · Groq.
Claude Code was used for research, implementation, tests and documentation.

## License

MIT. See [LICENSE](LICENSE) and [CREDITS.md](CREDITS.md).
