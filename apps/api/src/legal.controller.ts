import { Controller, Get, Header } from '@nestjs/common';

/**
 * 개인정보처리방침 / 데이터 삭제 안내.
 *
 * Meta 앱을 **라이브 모드로 전환하려면 개인정보처리방침 URL 이 필수**입니다. 외부
 * 호스팅을 새로 붙이는 대신 이미 공개 HTTPS 로 떠 있는 이 Lambda 에 라우트 하나를
 * 답니다 — 새 계정도, 새 인프라도, 배포 절차 변경도 없습니다.
 *
 * 내용은 코드가 실제로 하는 일과 일치해야 합니다. 바꾸려면 AGENTS.md §Privacy 와
 * schema.prisma 를 먼저 확인하세요. Phase 2 에서 웹앱이 생기면 그쪽으로 옮깁니다.
 */

// 공개 페이지에 실리는 값입니다. 바꾸려면 여기만 고치고 배포하면 됩니다.
const CONTACT_EMAIL = 'ctj0999@gmail.com';
const UPDATED_AT = '2026-09-03';

const PRIVACY_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>개인정보처리방침</title>
<style>
 body{max-width:44rem;margin:2rem auto;padding:0 1.2rem;line-height:1.7;
      font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#1a1a1a}
 h1{font-size:1.6rem} h2{font-size:1.1rem;margin-top:2rem}
 table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:.5rem;text-align:left;font-size:.95rem}
 code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px} footer{margin-top:3rem;color:#666;font-size:.9rem}
</style></head><body>
<h1>개인정보처리방침</h1>
<p>이 서비스는 Instagram 게시물에 달린 댓글에 자동으로 다이렉트 메시지를 보내는 도구입니다.
아래는 이 서비스가 <strong>실제로</strong> 저장하고 처리하는 것의 전부입니다.</p>

<h2>1. 수집·저장하는 정보</h2>
<table>
<tr><th>항목</th><th>용도</th></tr>
<tr><td>Instagram 사용자 식별자(IGSID)</td><td>같은 사람과의 대화 상태 추적</td></tr>
<tr><td>Instagram 사용자명</td><td>운영자 화면의 활동 내역 표시 (공개 정보)</td></tr>
<tr><td>댓글·메시지 이벤트의 메타데이터<br>(발생 시각, 게시물 ID, 처리 결과)</td><td>발송 여부 통계, "왜 DM 이 안 갔는지" 확인</td></tr>
<tr><td>연동 계정의 액세스 토큰 및 앱 시크릿</td><td>Instagram API 호출. <strong>AES-256-GCM 으로 암호화</strong>해 저장</td></tr>
</table>

<h2>2. 저장하지 않는 정보</h2>
<ul>
<li><strong>댓글 본문과 다이렉트 메시지 본문을 저장하지 않습니다.</strong> 키워드 일치 여부만 메모리에서 판단하고 본문은 버립니다.</li>
<li>로그에도 본문을 기록하지 않습니다.</li>
<li>액세스 토큰·시크릿을 평문으로 저장하거나 로그에 남기지 않습니다.</li>
<li>이메일, 전화번호, 결제 정보, 위치 정보를 수집하지 않습니다.</li>
</ul>

<h2>3. 제3자 제공</h2>
<p>수집한 정보를 판매하거나 제3자에게 제공하지 않습니다. 광고에 사용하지 않습니다.
서비스 운영에 필요한 범위에서 Amazon Web Services(인프라)와 Meta Platforms(Instagram API)를 이용합니다.</p>

<h2>4. 보관 기간</h2>
<ul>
<li>이벤트 기록: 연동 해제 시까지. 계정 삭제 시 함께 삭제됩니다.</li>
<li>서버 로그: <strong>7일 후 자동 삭제</strong>됩니다.</li>
</ul>

<h2>5. 데이터 삭제 요청</h2>
<p>아래 주소로 Instagram 사용자명을 알려주시면 해당 계정과 관련된 모든 기록을 삭제합니다.
연동 계정 소유자가 연동을 해제하면 그 계정의 데이터는 전부 함께 삭제됩니다.</p>
<p><code>${CONTACT_EMAIL}</code></p>

<h2>6. 문의</h2>
<p><code>${CONTACT_EMAIL}</code></p>

<footer>최종 수정일: ${UPDATED_AT}</footer>
</body></html>`;

@Controller()
export class LegalController {
  @Get('privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  privacy(): string {
    return PRIVACY_HTML;
  }

  /** Meta 가 "사용자 데이터 삭제" 안내 URL 을 따로 요구하면 이걸 준다. */
  @Get('data-deletion')
  @Header('Content-Type', 'text/html; charset=utf-8')
  dataDeletion(): string {
    return PRIVACY_HTML;
  }
}
