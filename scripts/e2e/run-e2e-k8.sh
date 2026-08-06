#!/usr/bin/env bash
# Harness E2E K8 — orquesta el pipeline completo del Cerebro Virtual OKF contra infra local.
# Cold-Tier real (Postgres 5436) + Ollama real (gemma4:12b) + bundle en disco (reemplaza GCS).
# NO usa: llave Gemini (embeddings mock), GCS real, GitHub real (git mock).
set -euo pipefail

export E2E_TENANT="${E2E_TENANT:-e2e-piloto}"
export E2E_BUNDLE_DIR="${E2E_BUNDLE_DIR:-/tmp/kdb-e2e/${E2E_TENANT}}"
export COLD_TIER_URL="${COLD_TIER_URL:-postgres://postgres:postgres@localhost:5436/postgres}"
export E2E_OLLAMA_MODEL="${E2E_OLLAMA_MODEL:-gemma4:12b}"

# Derivado de la ubicación del script: <ROOT>/context-kdb-compiler/scripts/e2e/
# Así el harness sobrevive a que se renombre o se mueva la carpeta raíz.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPILER="$ROOT/context-kdb-compiler"
NIGHTWORKER="$ROOT/night-worker"

echo "############################################################"
echo "# E2E K8 · Cerebro Virtual OKF · tenant=$E2E_TENANT"
echo "# bundle=$E2E_BUNDLE_DIR"
echo "# modelo=$E2E_OLLAMA_MODEL (dev; producción usa gemma/Gemini)"
echo "############################################################"

rm -rf "$E2E_BUNDLE_DIR" /tmp/kdb-e2e/_state /tmp/kdb-e2e/_mirror

echo ""
echo ">>> Script A — V2 (onboarding + seed + destilación L1)"
( cd "$COMPILER" && npx tsx scripts/e2e/01-v2.ts )

echo ""
echo ">>> Script B — V3 (consolidate + index-regen + eval + mirror)"
( cd "$NIGHTWORKER" && npx tsx scripts/e2e/02-v3.ts )

echo ""
echo ">>> Script C — indexación al Cold-Tier + prueba RLS"
( cd "$COMPILER" && npx tsx scripts/e2e/03-index.ts )

echo ""
echo "############################################################"
echo "# E2E K8 completado. Bundle inspeccionable en: $E2E_BUNDLE_DIR"
echo "############################################################"
