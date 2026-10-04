#!/usr/bin/env bash
# AGENT.ID — e2e Fase 6: auth-required (matriz 401, credenciales válidas,
# anti-replay HMAC, rate limit, y e2e-fase4 completo con auth activa).
#
# Formato HMAC (EXACTO de packages/sdk-auth/src/index.ts):
#   bodySha = sha256(rawBody) hex · message = METHOD\npathname\nbodySha
#   X-Signature = 'sha256=' + hex(HMAC-SHA256(secret, message)); X-Timestamp en ms
#
# Uso: CH=... IS=... CO=... PO=... [ANCHOR=...] GATEWAY=... \
#        E2E_SERVICE_KEY=... E2E_HMAC_SECRET=... E2E_OPERATOR_KEY=0x... \
#        [POB_KEY=0x...] bash e2e/e2e-auth.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTID="$ROOT"

CH="${CH:-https://challenges-production.up.railway.app}"
IS="${IS:-https://issuer-production-9388.up.railway.app}"
CO="${CO:-https://compliance-production-f8c6.up.railway.app}"
PO="${PO:-https://pob-api-production.up.railway.app}"
ANCHOR="${ANCHOR:-}"
GATEWAY="${GATEWAY:?GATEWAY=<url gateway-demo> es requerido}"
E2E_SERVICE_KEY="${E2E_SERVICE_KEY:?E2E_SERVICE_KEY es requerido}"
E2E_HMAC_SECRET="${E2E_HMAC_SECRET:?E2E_HMAC_SECRET es requerido}"
E2E_OPERATOR_KEY="${E2E_OPERATOR_KEY:?E2E_OPERATOR_KEY es requerido}"
E2E_SERVICE_ID="e2e"
export E2E_HMAC_SECRET E2E_SERVICE_ID

export AGENT_ID="e2e-auth-$(date +%s)"
BODY_TMP="$(mktemp)"

cleanup() { rm -f "$BODY_TMP"; }
trap cleanup EXIT

PASS=0
FAIL=0

step() { printf '\n[auth %s] %s\n' "$1" "$2"; }
ok()   { printf '  PASS: %s\n' "$*"; PASS=$((PASS + 1)); }
fail_step() { printf 'AUTH-E2E: FAIL en paso %s: %s\n' "$1" "$2" >&2; exit 1; }

# request <method> <url> [body] [curl extra...] → código HTTP en stdout, body en $BODY_TMP
request() {
  local method="$1" url="$2" body="${3:-}" code
  local args=(curl -sS -o "$BODY_TMP" -w '%{http_code}' -X "$method" "$url" --max-time 15)
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data-binary "$body")
  args+=("${@:4}")
  code="$("${args[@]}" || echo 000)"
  printf '%s' "$code"
}

# signed_request <method> <url> <body> [ts] [sig] → firma (o reutiliza ts/sig) y envía
signed_request() {
  local method="$1" url="$2" body="$3" ts="${4:-}" sig="${5:-}" path out
  path="$url"; path="${path#*://}"; path="${path#*/}"
  if [[ -z "$ts" ]]; then
    out="$(printf '%s' "$body" | HMAC_METHOD="$method" HMAC_ROUTE="$path" node -e '
      const crypto = require("node:crypto");
      let d = "";
      process.stdin.on("data", (c) => { d += c; });
      process.stdin.on("end", () => {
        const bodySha = crypto.createHash("sha256").update(d, "utf8").digest("hex");
        const msg = [process.env.HMAC_METHOD, "/" + process.env.HMAC_ROUTE, bodySha].join("\n");
        process.stdout.write(Date.now() + "\nsha256=" +
          crypto.createHmac("sha256", process.env.E2E_HMAC_SECRET).update(msg).digest("hex") + "\n");
      });
    ')" || fail_step "hmac" "no se pudo firmar"
    ts="$(printf '%s\n' "$out" | sed -n 1p)"
    sig="$(printf '%s\n' "$out" | sed -n 2p)"
  fi
  request "$method" "$url" "$body" \
    -H "X-Service-Key: $E2E_SERVICE_KEY" \
    -H "X-Service-Id: $E2E_SERVICE_ID" \
    -H "X-Timestamp: $ts" -H "X-Signature: $sig"
}

# --- a) Matriz de 401: mutaciones sin credencial --------------------------------
step a "Matriz 401 — mutaciones sin credencial deben dar 401"
for spec in \
  "compliance-kyc|$CO/kyc-attestation|{\"operatorAddress\":\"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\"}" \
  "compliance-erase|$CO/erase/$AGENT_ID|{}" \
  "issuer-attestation|$IS/attestation|{\"agentId\":\"$AGENT_ID\"}" \
  "challenges-challenge|$CH/challenge|{\"agentId\":\"$AGENT_ID\"}" \
  "pob-receipt|$PO/receipt|{}"; do
  name="${spec%%|*}"; rest="${spec#*|}"; url="${rest%%|*}"; body="${rest#*|}"
  code="$(request POST "$url" "$body")"
  if [[ "$code" == "401" ]]; then ok "$name → 401"; else fail_step "a-matriz" "$name dio HTTP $code (esperado 401); body: $(cat "$BODY_TMP")"; fi
done
if [[ -n "$ANCHOR" ]]; then
  code="$(request POST "$ANCHOR/anchor" '{}')"
  if [[ "$code" == "401" ]]; then ok "anchor-anchor → 401"; else fail_step "a-matriz" "anchor dio HTTP $code (esperado 401)"; fi
else
  printf '  SKIP: ANCHOR no definida — matriz 401 parcial\n'
fi

# --- b) Credenciales válidas: X-Service-Key → 201 --------------------------------
step b "Credenciales válidas — POST /challenge con X-Service-Key"
code="$(request POST "$CH/challenge" "{\"agentId\":\"$AGENT_ID\"}" -H "X-Service-Key: $E2E_SERVICE_KEY")"
if [[ "$code" == "201" ]]; then ok "challenge con service key → 201"; else fail_step "b-valid-creds" "POST /challenge dio HTTP $code (esperado 201); body: $(cat "$BODY_TMP")"; fi

# --- c) Anti-replay: misma firma+timestamp dos veces ------------------------------
step c "Anti-replay — 1ª llamada HMAC ≠401, replay de la misma firma → 401"
AT_BODY="{\"agentId\":\"$AGENT_ID\",\"certType\":\"compliance\",\"capabilitiesHash\":\"0x$(printf '%s' "$AGENT_ID" | sha256sum | cut -c1-64)\",\"challengeId\":\"e2e-auth-replay\"}"
OUT1="$(printf '%s' "$AT_BODY" | HMAC_METHOD="POST" HMAC_ROUTE="attestation" node -e '
  const crypto = require("node:crypto");
  let d = "";
  process.stdin.on("data", (c) => { d += c; });
  process.stdin.on("end", () => {
    const bodySha = crypto.createHash("sha256").update(d, "utf8").digest("hex");
    const msg = [process.env.HMAC_METHOD, "/" + process.env.HMAC_ROUTE, bodySha].join("\n");
    process.stdout.write(Date.now() + "\nsha256=" +
      crypto.createHmac("sha256", process.env.E2E_HMAC_SECRET).update(msg).digest("hex") + "\n");
  });
')"
TS1="$(printf '%s\n' "$OUT1" | sed -n 1p)"; SIG1="$(printf '%s\n' "$OUT1" | sed -n 2p)"
code="$(signed_request POST "$IS/attestation" "$AT_BODY" "$TS1" "$SIG1")"
if [[ "$code" != "401" ]] && ! grep -q '"error":"replay"' "$BODY_TMP"; then
  ok "1ª llamada aceptada por HMAC (HTTP $code, error negocio posible: $(cat "$BODY_TMP"))"
else
  fail_step "c-replay-1st" "1ª llamada HMAC dio 401/replay (HTTP $code); body: $(cat "$BODY_TMP")"
fi

code="$(request POST "$IS/attestation" "$AT_BODY" \
  -H "X-Service-Key: $E2E_SERVICE_KEY" \
  -H "X-Service-Id: $E2E_SERVICE_ID" \
  -H "X-Timestamp: $TS1" \
  -H "X-Signature: $SIG1")"
if [[ "$code" == "401" ]] && grep -q '"error":"replay"' "$BODY_TMP"; then
  ok "replay detectado → 401 error:replay"
else
  fail_step "c-replay-2nd" "replay dio HTTP $code (esperado 401 replay); body: $(cat "$BODY_TMP")"
fi

# --- d) Rate limit: 40 POSTs /challenge → 429 en algún punto ----------------------
step d "Rate limit — 40 POSTs /challenge con credencial válida (bucket 30/min)"
GOT_429=0
rm -f /tmp/e2e-auth-rl.log
for i in $(seq 1 40); do
  (
    c="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST "$CH/challenge" \
      -H 'content-type: application/json' \
      -H "X-Service-Key: $E2E_SERVICE_KEY" \
      --data-binary "{\"agentId\":\"$AGENT_ID-rl-$i\"}" 2>/dev/null || echo 000)"
    printf '%s\n' "$c" >> /tmp/e2e-auth-rl.log
  ) &
done
wait
if grep -qx "429" /tmp/e2e-auth-rl.log 2>/dev/null; then GOT_429=1; fi
if [[ "$GOT_429" == "1" ]]; then
  ok "429 en POST #$i (rate limit de mutación activo)"
else
  fail_step "d-ratelimit" "40 POSTs sin 429 — el rate limit de mutación no se activó"
fi
# El bucket 30/min queda agotado: dejar pasar la ventana antes del e2e-fase4
printf '  esperando 70s para que el bucket 30/min se resetee antes del e2e-fase4...\n'
sleep 70

# --- e) e2e-fase4 completo con auth activa ---------------------------------------
step e "e2e-fase4 completo (con credenciales exportadas)"
if OUT="$( \
  CH="$CH" IS="$IS" CO="$CO" PO="$PO" CR="${CR:-}" RE="${RE:-}" GATEWAY="$GATEWAY" \
  E2E_SERVICE_KEY="$E2E_SERVICE_KEY" E2E_HMAC_SECRET="$E2E_HMAC_SECRET" \
  E2E_OPERATOR_KEY="$E2E_OPERATOR_KEY" E2E_SIGNER_KEY="${E2E_SIGNER_KEY:-${POB_KEY:-}}" \
  bash "$ROOT/e2e/e2e-fase4.sh" 2>&1 )"; then
  if printf '%s' "$OUT" | grep -q 'RESULTADO: PASS'; then
    ok "e2e-fase4 RESULTADO: PASS"
    printf '%s\n' "$OUT" | tail -n 6
  else
    fail_step "e-fase4" "e2e-fase4 salió 0 pero sin RESULTADO: PASS"
  fi
else
  printf '%s\n' "$OUT" | tail -n 30 >&2
  fail_step "e-fase4" "e2e-fase4 terminó con error"
fi

printf '\nAUTH-E2E: %d PASS / 0 FAIL\n' "$PASS"
exit 0
