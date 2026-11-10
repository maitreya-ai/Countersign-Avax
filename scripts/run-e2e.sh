#!/usr/bin/env bash
# Full real run: deploy (if needed) -> mirror signers -> e2e pass / fail / injected
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

# self-attested mode (JUDGE_A=groq:… / gemini:…) needs no 0G at all
case "${JUDGE_A:-}" in groq:*|gemini:*) SELF=1 ;; *) SELF=0 ;; esac
[ "$SELF" = 1 ] || : "${ZG_PRIVATE_KEY:?ZG_PRIVATE_KEY is empty: put a funded 0G wallet key in .env (see README)}"
if [ -z "${VERDICT_ESCROW:-}" ]; then ./scripts/deploy.sh; set -a; source .env; set +a; fi

cd relayer
if [ "$SELF" = 0 ]; then
  echo "== fund 0G ledger + provider sub-accounts (skips funded ones)"; bun run src/fund.ts
  echo "== spike: one attested call end to end"; bun run src/spike.ts "${JUDGE_A:-glm-5.3}"
fi
echo "== mirror signers into SignerRegistry"; bun run src/registry-mirror.ts
cases=("$@"); [ ${#cases[@]} -eq 0 ] && cases=(pass fail injected)
for c in "${cases[@]}"; do
  echo "== e2e case: $c"; bun run src/e2e.ts "$c"
done
