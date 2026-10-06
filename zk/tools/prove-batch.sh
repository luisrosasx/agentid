#!/usr/bin/env bash
# EP-19-S3 — prove-batch.sh: estrategia incremental por sub-lotes.
#
# Uso:
#   bash zk/tools/prove-batch.sh --strategy incremental --size 16 --count 16
#     → genera `--count` sub-lotes de `--size` contrapartes (testigos deterministas
#       con gen-bench-witness.mjs sobre el mismo árbol), compila 1 vez, y prueba y
#       verifica cada sub-lote con nargo/bb en UN contenedor. Exit 0 si TODAS las
#       sub-pruebas se verifican.
#   --strategy monolithic → exit 3: ruta documentada como no apta por latencia
#       (23,45M gates, >10 min de prove — ver zk/benchmarks.md).
#
# Requiere /tmp/noir/{nargo,bb} (ver zk/benchmarks.md, nota de entorno).

set -euo pipefail
STRATEGY="incremental"; SIZE=16; COUNT=16
prev=""
for a in "$@"; do
  case "$a" in
    --strategy=*) STRATEGY="${a#*=}" ;;
    --size=*) SIZE="${a#*=}" ;;
    --count=*) COUNT="${a#*=}" ;;
    --strategy|--size|--count) prev="$a" ;;
    *)
      case "$prev" in
        --strategy) STRATEGY="$a" ;;
        --size) SIZE="$a" ;;
        --count) COUNT="$a" ;;
      esac
      prev=""
      ;;
  esac
done

if [[ "$STRATEGY" == "monolithic" ]]; then
  echo "REFUSAL: strategy=monolithic (23.45M gates, >10 min prove) — usar incremental" >&2
  exit 3
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # cardca/
W="${NOIR_BIN_DIR:-/tmp/noir}"
[[ -f "$W/nargo" && -f "$W/bb" ]] || { echo "faltan $W/nargo y $W/bb" >&2; exit 2; }

WORK="$(mktemp -d)"

ROOT_W="$(cygpath -w "$ROOT")"; WORK_W="$(cygpath -w "$WORK")"
python -X utf8 - "$ROOT_W" "$WORK_W" "$SIZE" "$COUNT" <<'EOF'
import sys, subprocess
root, work, size, count = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
import os
gen = os.path.join(root, "zk", "tools", "gen-bench-witness.mjs")
for i in range(count):
    r = subprocess.run(["node", gen, f"--active={size}", f"--seed={i}", f"--out={work}/prov{i}.toml"],
                       cwd=f"{root}/packages/sdk-receipts", capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
print(f"testigos: {count} generados (size={size}, seeds 0..{count-1})")
EOF

W=$(cygpath -w "$W"); WK=$(cygpath -w "$ROOT/zk/circuits/dc_subbatch"); LK=$(cygpath -w "$ROOT/zk/lib/keccak256"); WS=$(cygpath -w "$WORK")
export COUNT SIZE
MSYS_NO_PATHCONV=1 docker run --rm --platform linux/amd64 -e COUNT -e SIZE -v "$W:/noir" -v "$WK:/circ" -v "$LK:/root/lib_keccak" -v "$WS:/work" -w /circ debian:12-slim bash -c '
set -euo pipefail
chmod +x /noir/bb
T0=$(date +%s)
/noir/nargo compile >/dev/null 2>&1
/noir/nargo execute >/dev/null 2>&1
/noir/bb write_vk -b target/dc_subbatch.json -o /work/vk -t evm-no-zk >/dev/null 2>&1
echo "setup (compile+witness+VK): $(( $(date +%s) - T0 ))s"
for i in $(seq 0 $((COUNT-1))); do
  T=$(date +%s)
  cp /work/prov$i.toml Prover.toml
  /noir/nargo execute >/dev/null 2>&1
  /noir/bb prove -b target/dc_subbatch.json -w target/dc_subbatch.gz -k /work/vk/vk -o /work/proof$i -t evm-no-zk >/dev/null 2>&1
  if /noir/bb verify -k /work/vk/vk -p /work/proof$i/proof -i /work/proof$i/public_inputs -t evm-no-zk >/dev/null 2>&1; then
    echo "sub-lote $i: VERIFICADA ($(( $(date +%s) - T ))s)"
  else
    echo "sub-lote $i: FALLO"; exit 1
  fi
done
echo "TOTAL: $COUNT/$COUNT sub-pruebas verificadas"
'
