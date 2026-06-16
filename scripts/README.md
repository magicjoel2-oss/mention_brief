# scripts/

자동화 스크립트 모음. 사양서(`automation-spec.md`) §4를 Power Automate에서 로컬 Node/PowerShell로 옮긴 구현.

## 진행 단계

1. **`auth-poc.ps1`** — 인증 PoC (현재 단계)
   - PowerShell 7 또는 Windows PowerShell 5.1에서 실행
   - `Microsoft.Graph.Authentication` 모듈로 device code flow 시도
   - 5분 안에 결과 나옴: STAGE 1~5 중 어디서 막히는지 확인

2. **`generate-digest.mjs`** — 디지스트 생성 (인증 통과 후)
   - 멘션 수집 → 필터링 → AI 분류 → JSON 생성 → git commit

3. **`register-task.ps1`** — Windows 작업 스케줄러 등록 (자동화 마무리)

## 첫 실행

```powershell
cd C:\AiApps\mention_brief
.\scripts\auth-poc.ps1
```

device code 화면이 뜨면 안내된 URL과 코드로 본인 회사 계정 인증. STAGE 2까지 통과해야 진행 가능.

## 인증 결과별 다음 행동

| STAGE 도달 | 의미 | 다음 |
|---|---|---|
| 1만 통과 (모듈 설치) | PSGallery 차단 가능 | 옵션 D(Edge debug port)로 전환 |
| 2 실패 | IdP/Conditional Access 차단 | 에러 AADSTS 코드 보고 → D로 전환 |
| 3~4 통과 | Graph 호출 가능 | generate-digest.mjs 진행 |
| 5 실패 | Search 스코프 부족 | 검색 대신 chat 순회 방식 |
