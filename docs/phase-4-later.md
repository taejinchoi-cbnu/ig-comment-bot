# Phase 4 — 그 다음 (선택)

> **상태**: 대기   |   **선행**: Phase 3
>
> 완료 기준 없음. Phase 3까지가 목표이고 여기는 여유가 있을 때.

우선순위 순.

## 1. Instagram Insights 연동 — 도달 대비 전환율

가장 값어치 있는 후보. **상용 서비스도 잘 안 엮어주는 지점**이다.

```http
GET /v25.0/{media-id}/insights?metric=reach,impressions,saved,shares
```
- [ ] `instagram_business_manage_insights` 권한이 Standard Access로 되는지 **먼저 확인**
- [ ] 게시글별 `도달 N명 → 댓글 N → DM N → 답장 N` 전체 퍼널 완성
- [ ] 지표는 시간이 지나면 변하므로 스냅샷 테이블에 날짜별로 쌓는다

"도달 대비 몇 %가 댓글을 달았나"는 지금 어떤 도구로도 보기 어렵다.

## 2. 팔로워 게이트

`is_user_follow_business`로 분기 — 팔로워면 바로 양식, 아니면 팔로우 요청 후 안내.
1차 메시지 문구가 원래 "팔로워인지 확인할게요!"였던 걸 보면 처음부터 의도했던 기능이다.

- [ ] **대화 성립 후에만 조회 가능** ([`meta-api.md`](./meta-api.md) #13) → MESSAGE 핸들러에서만
- [ ] 핸들러 파일 하나 + 레지스트리 한 줄

## 3. 시간대/요일별 반응 패턴

`events.created_at`만으로 나온다. "언제 올려야 반응이 좋은가"에 답한다.

## 4. 토큰 자동 갱신

60일 장기 토큰이 만료되면 조용히 멈춘다.
- [ ] 만료 임박 계정 감지 → 대시보드 경고 (**이게 먼저**)
- [ ] `GET /refresh_access_token` 크론

## 5. 그 외

- 스토리 멘션 / 릴스 트리거 — `normalize` 케이스 + 핸들러 추가
- 자동 DM A/B 테스트 — `Campaign`에 필드 추가
- 예약 발송 · AI 응답
- CloudWatch 알람 (DLQ > 0)
- 양식 응답 파싱·저장 — **개인정보 보존 정책 수립이 선행**

## 안 할 것

- **플로우 빌더 / 조건 분기 UI** — [`why.md`](./why.md) 원칙 1 위반. 상용 서비스가 어려운 이유가 정확히 이것이다
- **Meta App Review / Advanced Access** — 상용화를 안 하므로 불필요
- **결제 · 요금제**

## 진행 기록

<!-- -->
