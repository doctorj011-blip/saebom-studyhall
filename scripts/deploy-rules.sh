#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Firestore 규칙 배포 헬퍼
#   firestore.rules(원본)를 검토한 뒤 콘솔에 배포합니다.
#   ※ 콘솔에서 직접 수정하지 말고 항상 이 파일 → 배포 흐름을 쓰세요.
#
#   사용법:  bash scripts/deploy-rules.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

RULES="firestore.rules"
[ -f "$RULES" ] || { echo "❌ $RULES 가 없습니다."; exit 1; }

echo "══════════════════════════════════════════════════════════"
echo " Firestore 규칙 배포 — 원본: $RULES"
echo "══════════════════════════════════════════════════════════"
echo
echo "▶ 마지막 커밋 이후 이 파일의 변경분:"
if git diff --quiet -- "$RULES" 2>/dev/null; then
  echo "  (작업트리 변경 없음 — 현재 커밋된 규칙 그대로 배포합니다)"
else
  git --no-pager diff -- "$RULES"
fi
echo
echo "▶ 상단 [배포 이력]:"
grep -n -A6 '\[배포 이력\]' "$RULES" | sed 's/^/  /'
echo

read -r -p "이 규칙으로 콘솔을 교체 배포할까요? 콘솔의 현재 규칙은 이 파일로 덮어써집니다. (y/N) " ans
case "$ans" in
  y|Y) ;;
  *) echo "취소했습니다."; exit 1 ;;
esac

firebase deploy --only firestore:rules
echo
echo "✅ 배포 완료."
echo "   → firestore.rules 상단 [배포 이력]에 오늘 날짜·변경 요약을 남기고 커밋하세요."
