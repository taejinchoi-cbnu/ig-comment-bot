#!/usr/bin/env bash
# 스테이지된 변경에서 실제 자격증명으로 보이는 문자열을 찾아 커밋을 막는다.
# 문서에서 패턴 이름만 언급하는 건 통과하도록, 프리픽스 뒤 길이까지 본다.
# 의도적으로 넣어야 하면 해당 줄에 "pragma: allowlist" 를 붙인다.
set -uo pipefail

added=$(git diff --cached -U0 --no-color | grep -E '^\+' | grep -v -E '^\+\+\+' | grep -v 'pragma: allowlist' || true)
[ -z "$added" ] && exit 0

declare -a NAMES=(
  "AWS 액세스 키"
  "AWS 임시 액세스 키"
  "Instagram 액세스 토큰"
  "Instagram 액세스 토큰(구형)"
  "Facebook Graph 토큰"
  "Meta App Secret"
  "개인키 블록"
)
declare -a PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'IGAA[A-Za-z0-9_-]{30,}'
  'IGQ[A-Za-z0-9_-]{30,}'
  'EAA[A-Za-z0-9]{30,}'
  '(app_?[Ss]ecret|APP_SECRET)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[0-9a-f]{32}'
  'BEGIN [A-Z ]*PRIVATE KEY'
)

found=0
for i in "${!PATTERNS[@]}"; do
  if hit=$(printf '%s\n' "$added" | grep -nE "${PATTERNS[$i]}" | head -3); then
    [ -z "$hit" ] && continue
    [ $found -eq 0 ] && echo "커밋 차단: 자격증명으로 보이는 값이 스테이지에 있습니다." >&2
    found=1
    echo "" >&2
    echo "  [${NAMES[$i]}]" >&2
    printf '%s\n' "$hit" | sed 's/^/    /' >&2
  fi
done

if [ $found -eq 1 ]; then
  cat >&2 <<'MSG'

값을 제거하고 Secrets Manager 또는 ops/ 아래로 옮기세요.
오탐이면 해당 줄 끝에 주석으로 "pragma: allowlist" 를 붙이면 통과합니다.
MSG
  exit 1
fi
exit 0
