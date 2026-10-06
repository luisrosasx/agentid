#!/usr/bin/env bash
# e2e/railway-smoke.sh — Smoke test e2e de los servicios CardCA desplegados en Railway.
#
# Variables de entorno requeridas (URLs base sin slash final):
#   RAILWAY_CHALLENGES_URL  RAILWAY_ISSUER_URL   RAILWAY_RESOLVER_URL
#   RAILWAY_POB_URL         RAILWAY_CREDIT_URL   RAILWAY_COMPLIANCE_URL
#   RAILWAY_ANCHOR_URL      RAILWAY_PORTAL_URL
#
# Uso: bash e2e/railway-smoke.sh
set -u

FAILURES=0

assert_contains() {
  local name="$1" body="$2" needle="$3"
  if printf '%s' "$body" | grep -q "$needle"; then
    echo "PASS: $name"
  else
    echo "FAIL: $name (esperaba '$needle' en: ${body:0:300})"
    FAILURES=$((FAILURES + 1))
  fi
}

healthz() {
  local label="$1" url="${2%/}"
  if [ -z "$url" ]; then
    echo "FAIL: $label (variable de entorno no definida)"
    FAILURES=$((FAILURES + 1))
    return
  fi
  if body=$(curl -sf --max-time 15 "$url/healthz"); then
    assert_contains "$label /healthz" "$body" 'ok":true'
  else
    echo "FAIL: $label /healthz (curl falló)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "== healthz de todos los servicios =="
healthz "challenges"  "${RAILWAY_CHALLENGES_URL:-}"
healthz "issuer"      "${RAILWAY_ISSUER_URL:-}"
healthz "resolver"    "${RAILWAY_RESOLVER_URL:-}"
healthz "pob"         "${RAILWAY_POB_URL:-}"
healthz "credit"      "${RAILWAY_CREDIT_URL:-}"
healthz "compliance"  "${RAILWAY_COMPLIANCE_URL:-}"
healthz "anchor"      "${RAILWAY_ANCHOR_URL:-}"
healthz "portal"      "${RAILWAY_PORTAL_URL:-}"

echo "== flujo e2e =="
CH_URL="${RAILWAY_CHALLENGES_URL:-}"
IS_URL="${RAILWAY_ISSUER_URL:-}"
RE_URL="${RAILWAY_RESOLVER_URL:-}"
PO_URL="${RAILWAY_POB_URL:-}"
CR_URL="${RAILWAY_CREDIT_URL:-}"

if [ -n "$CH_URL" ] && [ -n "$IS_URL" ] && [ -n "$RE_URL" ] && [ -n "$PO_URL" ] && [ -n "$CR_URL" ]; then
  CH_URL="${CH_URL%/}"; IS_URL="${IS_URL%/}"; RE_URL="${RE_URL%/}"; PO_URL="${PO_URL%/}"; CR_URL="${CR_URL%/}"

  # 1) POST /challenge
  challenge_res=$(curl -sf --max-time 15 -X POST -H 'Content-Type: application/json' -d '{"agentDid":"did:agent:e2e-smoke"}' "$CH_URL/challenge" 2>/dev/null)
  if [ -z "$challenge_res" ]; then
    echo "FAIL: POST /challenge"
    FAILURES=$((FAILURES + 1))
    challenge_id=""
  else
    challenge_id=$(printf '%s' "$challenge_res" | jq -r '.id // .challenge.id // empty' 2>/dev/null)
    if [ -n "$challenge_id" ]; then
      echo "PASS: POST /challenge (id=$challenge_id)"
    else
      echo "FAIL: POST /challenge (no se pudo extraer id de: ${challenge_res:0:300})"
      FAILURES=$((FAILURES + 1))
    fi
  fi

  # 2) POST /challenge/:id/answer
  if [ -n "$challenge_id" ]; then
    answer_res=$(curl -sf --max-time 15 -X POST -H 'Content-Type: application/json' -d '{"signature":"e2e-smoke-signature"}' "$CH_URL/challenge/$challenge_id/answer" 2>/dev/null)
    if [ -n "$answer_res" ]; then
      assert_contains "POST /challenge/:id/answer" "$answer_res" 'verified'
    else
      echo "FAIL: POST /challenge/:id/answer (curl falló)"
      FAILURES=$((FAILURES + 1))
    fi
  fi

  # 3) POST issuer /attestation
  attestation_res=$(curl -sf --max-time 15 -X POST -H 'Content-Type: application/json' \
    -d '{"agentId":"did:agent:e2e-smoke","certType":"AGENT.CERT","capabilities":["read","write"]}' \
    "$IS_URL/attestation" 2>/dev/null)
  if [ -n "$attestation_res" ]; then
    assert_contains "POST issuer /attestation" "$attestation_res" 'attestation'
  else
    echo "FAIL: POST issuer /attestation (curl falló)"
    FAILURES=$((FAILURES + 1))
  fi

  # 4) GET resolver /resolve/:agentId — assert valid:true
  resolve_res=$(curl -sf --max-time 15 "$RE_URL/resolve/did:agent:e2e-smoke" 2>/dev/null)
  if [ -n "$resolve_res" ]; then
    assert_contains "GET resolver /resolve/:agentId" "$resolve_res" 'valid":true'
  else
    echo "FAIL: GET resolver /resolve/:agentId (curl falló)"
    FAILURES=$((FAILURES + 1))
  fi

  # 5) POST pob /receipt
  receipt_res=$(curl -sf --max-time 15 -X POST -H 'Content-Type: application/json' \
    -d '{"agentId":"did:agent:e2e-smoke","behavior":{"action":"deploy","ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}}' \
    "$PO_URL/receipt" 2>/dev/null)
  if [ -n "$receipt_res" ]; then
    assert_contains "POST pob /receipt" "$receipt_res" 'receipt'
  else
    echo "FAIL: POST pob /receipt (curl falló)"
    FAILURES=$((FAILURES + 1))
  fi

  # 6) GET pob /score/:agentId
  score_res=$(curl -sf --max-time 15 "$PO_URL/score/did:agent:e2e-smoke" 2>/dev/null)
  if [ -n "$score_res" ]; then
    assert_contains "GET pob /score/:agentId" "$score_res" 'score'
  else
    echo "FAIL: GET pob /score/:agentId (curl falló)"
    FAILURES=$((FAILURES + 1))
  fi

  # 7) GET credit /account/:agentId — assert dailyLimitWei presente
  credit_res=$(curl -sf --max-time 15 "$CR_URL/account/did:agent:e2e-smoke" 2>/dev/null)
  if [ -n "$credit_res" ]; then
    assert_contains "GET credit /account/:agentId" "$credit_res" 'dailyLimitWei'
  else
    echo "FAIL: GET credit /account/:agentId (curl falló)"
    FAILURES=$((FAILURES + 1))
  fi
else
  echo "FAIL: flujo e2e omitido — faltan una o más variables RAILWAY_*"
  FAILURES=$((FAILURES + 1))
fi

echo ""
echo "Total de fallos: $FAILURES"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
echo "ALL GREEN"
