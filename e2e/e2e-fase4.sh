#!/usr/bin/env bash
# AGENT.ID — e2e Fase 4 (Cuenta Agentil + gateway-demo): flujo completo EN VIVO
# contra Railway, A TRAVÉS del gateway-demo.
#
# Contratos reales verificados en el código:
#   compliance  POST /kyc-attestation {operatorAddress} → 201 (EIP-712 KYC, 30 días)
#   challenges  POST /challenge {agentId} → 201 {id, prompt, nonce}; la respuesta
#               válida es el `nonce` (answerHash = sha256(prompt:answer))
#   issuer      POST /attestation {agentId, certType (STRING), capabilitiesHash
#               (0x+64hex), challengeId} → 201 {attestation, signature, issuer, digest}
#   resolver    POST /verify {attestation, signature, issuer} → {valid:true}
#   pob-api     POST /receipt {receipt:{agentId, counterparty(address), outcome,
#               nonce, issuedAt}, signature} → 201; firma EIP-712 del signer POB_KEY
#   credit      GET /account/:agentId → {dailyLimitWei, ...}
#   gateway     POST /enforce {agentId, target, amountWei} → allow=200 {decision:"allow"}
#               / deny=403 {decision:"deny"}; GET /metrics → {decisions, totalDecisions}
#
# NOTA despliegue: el policy del gateway-demo es por env (DAILY_QUOTA_WEI /
# PER_CALL_MAX_WEI). Para que los pasos 8-9 reflejen el límite del underwriter
# (credit), la Railway del gateway debe tener DAILY_QUOTA_WEI y
# PER_CALL_MAX_WEI >= dailyLimitWei de credit para el agente del test.
#
# Uso: GATEWAY=https://... CH=... IS=... RE=... CO=... PO=... CR=... POB_KEY=0x... \
#        bash development/evals/e2e-fase4.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTID="$ROOT"

CH="${CH:-https://challenges-production.up.railway.app}"
IS="${IS:-https://issuer-production-9388.up.railway.app}"
RE="${RE:-https://resolver-production-87f2.up.railway.app}"
CO="${CO:-https://compliance-production-f8c6.up.railway.app}"
PO="${PO:-https://pob-api-production.up.railway.app}"
CR="${CR:-https://credit-production-677c.up.railway.app}"
GATEWAY="${GATEWAY:?GATEWAY=<url gateway-demo> es requerido (gateway-demo aún no desplegado)}"

export AGENT_ID="e2e-fase4-$(date +%s)"
export OPERATOR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export COUNTERPARTY="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
export TARGET="demo-target"

PASS=0
FAIL=0
HTTP_CODE_FILE=/tmp/e2e-fase4-code

step() { printf '\n[step %s] %s\n' "$1" "$2"; }
ok()   { printf '  PASS: %s\n' "$*"; PASS=$((PASS + 1)); }
ko()   { printf '  FAIL: %s\n' "$*" >&2; FAIL=$((FAIL + 1)); }

http() { # http <method> <url> [json-body] → imprime body; guarda código en $HTTP_CODE_FILE
  local method="$1" url="$2" body="${3:-}"
  local args=(curl -sS -o /tmp/e2e-fase4-body.json -w '%{http_code}' -X "$method" "$url" --max-time 15)
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' -d "$body")
  echo "$("${args[@]}" || echo 000)" > "$HTTP_CODE_FILE"
  cat /tmp/e2e-fase4-body.json
}

expect_code() { # expect_code <esperado> <etiqueta>
  HTTP_CODE=$(cat "$HTTP_CODE_FILE" 2>/dev/null || echo 000)
  if [[ "$HTTP_CODE" == "$1" ]]; then ok "$2 (HTTP $HTTP_CODE)"; else ko "$2 (HTTP $HTTP_CODE, esperado $1)"; return 1; fi
}

# --- Preflight ----------------------------------------------------------------
step 0 "Preflight: healthz de los 7 servicios + gateway"
for url in "$CH/healthz" "$IS/healthz" "$RE/healthz" "$CO/healthz" "$PO/healthz" "$CR/healthz" "$GATEWAY/healthz"; do
  if curl -fsS "$url" >/dev/null 2>&1; then ok "healthz $url"; else ko "healthz $url"; fi
done

# --- Paso 1: KYC firmado (compliance) -----------------------------------------
step 1 "KYC firmado — compliance /kyc-attestation"
KYC_JSON="$(http POST "$CO/kyc-attestation" "{\"operatorAddress\":\"$OPERATOR\"}" || true)"
if expect_code 201 "atestación KYC emitida"; then
  if printf '%s' "$KYC_JSON" | grep -q '"signature"'; then ok "KYC incluye firma EIP-712"; else ko "KYC sin signature"; fi
else
  ko "KYC response: $KYC_JSON"
fi

# --- Paso 2: reto + respuesta (challenges) -------------------------------------
step 2 "Reto generativo + respuesta — challenges"
CH_JSON="$(http POST "$CH/challenge" "{\"agentId\":\"$AGENT_ID\"}" || true)"
if expect_code 201 "reto emitido" && CH_ID=$(printf '%s' "$CH_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).id)}catch{console.log("")}})' 2>/dev/null) && [[ -n "$CH_ID" ]]; then
  ok "challengeId: $CH_ID"
  ANS_JSON="$(http POST "$CH/challenge/$CH_ID/answer" "{\"answer\":\"$(printf '%s' "$CH_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).nonce)}catch{console.log("")}})')\"}" || true)"
  if expect_code 200 "respuesta aceptada" && printf '%s' "$ANS_JSON" | grep -q '"passed":true'; then
    ok "passed:true con proofHash"
  else
    ko "challenge no superado: $ANS_JSON"
  fi
else
  ko "no se obtuvo challengeId: $CH_JSON"
fi

# --- Paso 3: atestación AGENT.CERT (issuer) ------------------------------------
step 3 "Atestación AGENT.CERT — issuer /attestation"
CAPS_HASH="0x$(printf '%s' "$AGENT_ID" | sha256sum | cut -c1-64)"
AT_JSON="$(http POST "$IS/attestation" "{\"agentId\":\"$AGENT_ID\",\"certType\":\"compliance\",\"capabilitiesHash\":\"$CAPS_HASH\",\"challengeId\":\"$CH_ID\"}" || true)"
if expect_code 201 "atestación firmada (certType string, capabilitiesHash bytes32)" \
   && printf '%s' "$AT_JSON" | grep -q '"signature"'; then
  ok "issuer: $(printf '%s' "$AT_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).issuer)}catch{console.log("?")}})' 2>/dev/null)"
else
  ko "issuer response: $AT_JSON"
fi

# --- Paso 4: verificación vía resolver -----------------------------------------
step 4 "Verificación de atestación — resolver /verify"
VER_JSON="$(http POST "$RE/verify" "$AT_JSON" || true)"
if expect_code 200 "verificación EIP-712 + vigencia" && printf '%s' "$VER_JSON" | grep -q '"valid":true'; then
  ok "resolver valida la atestación"
else
  ko "resolver response: $VER_JSON"
fi

# --- Paso 5: recibo bilateral firmado (pob-api, POB_KEY) ------------------------
step 5 "Recibo bilateral firmado — pob-api /receipt (firma con POB_KEY)"
if [[ -n "${E2E_SIGNER_KEY:-${POB_KEY:-}}" ]]; then
  RECEIPT_SIG="$(cd "$AGENTID/apps/pob-api" && node --input-type=module -e "
    const { ethers } = await import('ethers');
    const wallet = new ethers.Wallet(process.env.E2E_SIGNER_KEY ?? process.env.POB_KEY);
    const domain = { name: 'AGENT.ID Proof-of-Behavior', version: '1' };
    const types = { Receipt: [
      { name: 'agentId', type: 'string' },
      { name: 'counterparty', type: 'address' },
      { name: 'outcome', type: 'string' },
      { name: 'nonce', type: 'string' },
      { name: 'issuedAt', type: 'string' },
    ] };
    const receipt = {
      agentId: process.env.AGENT_ID,
      counterparty: process.env.COUNTERPARTY,
      outcome: 'success',
      nonce: 'e2e-fase4-' + Date.now(),
      issuedAt: new Date().toISOString(),
    };
    wallet.signTypedData(domain, types, receipt).then((sig) => {
      console.log(JSON.stringify({ receipt, signature: sig }));
    });
  " 2>/dev/null)" || RECEIPT_SIG=""
  if [[ -n "$RECEIPT_SIG" ]] \
     && REC_JSON="$(http POST "$PO/receipt" "$RECEIPT_SIG" || true)" \
     && expect_code 201 "recibo aceptado y verificado" \
     && printf '%s' "$REC_JSON" | grep -q '"accepted":true'; then
    ok "recibo persistido (signer: $(printf '%s' "$REC_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).signer)}catch{console.log("?")}})' 2>/dev/null))"
  else
    ko "recibo rechazado: ${REC_JSON:-<sin firma generable>}"
  fi
else
  ko "POB_KEY no definida — no se puede firmar el recibo"
fi

# --- Paso 6: score + credencial (pob-api) --------------------------------------
step 6 "Score y credencial — pob-api"
SC_JSON="$(http GET "$PO/score/$AGENT_ID" || true)"
if expect_code 200 "score consultado" \
   && SC=$(printf '%s' "$SC_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).score)}catch{console.log("")}})' 2>/dev/null) && [[ -n "$SC" ]]; then
  ok "score=$SC receipts/distinctCounterparties presentes"
else
  ko "score response: $SC_JSON"
fi
CRED_JSON="$(http POST "$PO/credential/$AGENT_ID" '{}' || true)"
if expect_code 200 "credencial firmada vigencia 24h" && printf '%s' "$CRED_JSON" | grep -q '"signature"'; then
  ok "credencial emitida"
else
  ko "credencial response: $CRED_JSON"
fi

# --- Paso 7: límite de crédito (credit) ----------------------------------------
step 7 "Límite de crédito — credit /account/:agentId"
LIMIT_JSON="$(http GET "$CR/account/$AGENT_ID" || true)"
if expect_code 200 "política de crédito consultada" \
   && LIMIT_WEI=$(printf '%s' "$LIMIT_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).dailyLimitWei)}catch{console.log("")}})' 2>/dev/null) && [[ "$LIMIT_WEI" =~ ^[0-9]+$ ]]; then
  ok "dailyLimitWei=$LIMIT_WEI (scoreSource: $(printf '%s' "$LIMIT_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).scoreSource)}catch{console.log("?")}})' 2>/dev/null))"
  AMOUNTS="$(node -e "
    const L = BigInt(process.argv[1]);
    console.log((L / 2n).toString() + ' ' + (L * 2n + 1n).toString());
  " "$LIMIT_WEI")"
  ALLOW_AMT="$(echo "$AMOUNTS" | cut -d' ' -f1)"
  DENY_AMT="$(echo "$AMOUNTS" | cut -d' ' -f2)"
  ok "montos de prueba: allow=$ALLOW_AMT deny=$DENY_AMT (wei)"
else
  ko "credit response: $LIMIT_JSON"
  ALLOW_AMT=""; DENY_AMT=""
fi

# --- Paso 8: enforce monto < límite → allow ------------------------------------
step 8 "Enforcement allow — gateway /enforce monto < límite"
if [[ -n "$ALLOW_AMT" ]]; then
  EN_JSON="$(http POST "$GATEWAY/enforce" "{\"agentId\":\"$AGENT_ID\",\"target\":\"$TARGET\",\"amountWei\":\"$ALLOW_AMT\"}" || true)"
  if [[ "$(cat "$HTTP_CODE_FILE")" == "200" ]] && printf '%s' "$EN_JSON" | grep -q '"decision":"allow"'; then
    ok "allow (HTTP 200)"
  else
    ko "esperaba allow/200, obtuve HTTP $(cat "$HTTP_CODE_FILE"): $EN_JSON"
  fi
else
  ko "sin límite del paso 7 — no se puede probar"
fi

# --- Paso 9: enforce monto > límite → deny -------------------------------------
step 9 "Enforcement deny — gateway /enforce monto > límite"
if [[ -n "$DENY_AMT" ]]; then
  EN_JSON="$(http POST "$GATEWAY/enforce" "{\"agentId\":\"$AGENT_ID\",\"target\":\"$TARGET\",\"amountWei\":\"$DENY_AMT\"}" || true)"
  if [[ "$(cat "$HTTP_CODE_FILE")" == "403" ]] && printf '%s' "$EN_JSON" | grep -q '"decision":"deny"'; then
    ok "deny (HTTP 403)"
  else
    ko "esperaba deny/403, obtuve HTTP $(cat "$HTTP_CODE_FILE"): $EN_JSON"
  fi
else
  ko "sin límite del paso 7 — no se puede probar"
fi

# --- Paso 10: x20 enforce allow + /metrics -------------------------------------
step 10 "Ráfaga x20 enforce allow + verificación de /metrics"
for _ in $(seq 1 20); do
  http POST "$GATEWAY/enforce" "{\"agentId\":\"$AGENT_ID\",\"target\":\"$TARGET\",\"amountWei\":\"1\"}" >/dev/null 2>&1 || true
done
MET_JSON="$(http GET "$GATEWAY/metrics" || true)"
if expect_code 200 "GET /metrics" \
   && MET=$(printf '%s' "$MET_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const m=JSON.parse(d);console.log(m.decisions.allow + " " + m.decisions.deny + " " + m.totalDecisions)}catch{console.log("")}})' 2>/dev/null) && [[ -n "$MET" ]]; then
  MET_ALLOW=$(echo "$MET" | cut -d' ' -f1); MET_DENY=$(echo "$MET" | cut -d' ' -f2); MET_TOTAL=$(echo "$MET" | cut -d' ' -f3)
  if [[ "$MET_ALLOW" -ge 21 && "$MET_DENY" -ge 1 && "$MET_TOTAL" -ge 22 ]]; then
    ok "metrics: allow=$MET_ALLOW deny=$MET_DENY total=$MET_TOTAL (>= 21 allow, >= 1 deny)"
  else
    ko "metrics inconsistentes: allow=$MET_ALLOW deny=$MET_DENY total=$MET_TOTAL (esperado >=21/1/22)"
  fi
else
  ko "metrics response: $MET_JSON"
fi

# --- Resumen -------------------------------------------------------------------
printf '\n================ RESUMEN e2e Fase 4 ================\n'
printf 'agentId del test: %s\n' "$AGENT_ID"
printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  printf 'RESULTADO: FAIL\n'
  exit 1
fi
printf 'RESULTADO: PASS — flujo KYC→reto→cert→resolver→recibo→score→crédito→enforce→metrics OK\n'
exit 0
