#!/usr/bin/env bash
# Deploys SignerRegistry, CountersignOracle, CountersignEscrow to Arc testnet and writes the addresses into .env
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

: "${ARC_PRIVATE_KEY:?set ARC_PRIVATE_KEY in .env}"
: "${USDC:?set USDC in .env}"

echo "deployer $(cast wallet address --private-key "$ARC_PRIVATE_KEY")  balance $(cast balance --rpc-url "$ARC_RPC" "$(cast wallet address --private-key "$ARC_PRIVATE_KEY")" --ether) USDC (gas)"

OUT=$(cd contracts && USDC="$USDC" ARC_PRIVATE_KEY="$ARC_PRIVATE_KEY" forge script script/Deploy.s.sol \
  --rpc-url "$ARC_RPC" --broadcast --legacy 2>&1 | tee /dev/stderr)

REG=$(echo "$OUT" | awk '/SignerRegistry/ {print $2}' | tail -1)
ORA=$(echo "$OUT" | awk '/CountersignOracle/ {print $2}' | tail -1)
ESC=$(echo "$OUT" | awk '/CountersignEscrow/ {print $2}' | tail -1)

sed -i '' -E "s/^SIGNER_REGISTRY=.*/SIGNER_REGISTRY=$REG/; s/^VERDICT_ORACLE=.*/VERDICT_ORACLE=$ORA/; s/^VERDICT_ESCROW=.*/VERDICT_ESCROW=$ESC/" .env
cat > web/addresses.json <<JSON
{
  "network": "arc-testnet",
  "chainId": 5042002,
  "escrow": "$ESC",
  "oracle": "$ORA",
  "registry": "$REG",
  "explorer": "https://explorer.testnet.arc.io",
  "judges": ${JUDGES:-2},
  "zg": { "chainId": ${ZG_CHAIN_ID:-16661}, "rpc": "${ZG_RPC:-https://evmrpc.0g.ai}", "inferenceServing": "${ZG_INFERENCE_SERVING:-0x47340d900bdFec2BD393c626E12ea0656F938d84}" }
}
JSON
echo
echo "SignerRegistry $REG"
echo "CountersignOracle  $ORA"
echo "CountersignEscrow  $ESC"
echo "written to .env"
