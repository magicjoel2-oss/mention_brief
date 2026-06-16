# Teams 멘션 디지스트 자동화 사양서

> **버전** 1.0 · 2026-06-12 작성  
> **소유자** magicjoel (이민우)  
> **상태** 운영 7일치 시행착오 누적 → 자동화 단계 진입

---

## 1. 개요

### 1.1 목적

매일 정해진 시각, 본인(magicjoel)을 멘션한 지난 24시간의 Teams 메시지를 수집·요약·분류해서 정적 웹페이지 형태로 받아본다. 본인이 항목별로 "확인 완료"를 체크할 수 있고, 미체크 항목은 자동으로 누적 미해결 목록에 남는다.

### 1.2 7일치 운영에서 확정된 사실들

| 분류 | 결정 |
|---|---|
| **저장소 위치** | GitHub repo의 `data/*.json` (참조 사이트인 morning-brief 동일 패턴) |
| **데이터 흐름** | Power Automate → JSON 생성 → GitHub Content API로 commit → GitHub Pages에서 정적 서빙 |
| **렌더링** | Vanilla JS 단일 HTML, 빌드 단계 없음 |
| **체크 상태** | localStorage (1대 디바이스 사용으로 충분) |
| **보유 기간** | 해결된 건 14일 자동 정리, 데이터는 무기한 보존 |
| **채팅방 라벨** | 3단계 폴백: `topic` → `members` 조합 → 수동 매핑 |

### 1.3 한 그림

```
[09:00 KST 매일]
    │
    ▼
┌──────────────────────────────────────┐
│ Power Automate Cloud Flow            │
│                                      │
│  ① Teams Graph API: 지난 24h 멘션   │
│  ② 본인 발신 필터링                  │
│  ③ 잘린 본문 풀텍스트 보강           │
│  ④ 채팅방 라벨 3단계 폴백            │
│  ⑤ AI: 요약 + 권장 코멘트            │
│  ⑥ 우선순위 자동 분류                │
│  ⑦ 연쇄 메시지 그루핑                │
│  ⑧ JSON 생성                         │
│  ⑨ GitHub Content API로 commit       │
└──────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────┐
│ GitHub Pages (정적 호스팅)            │
│   index.html (vanilla JS)            │
│   data/index.json                    │
│   data/YYYY-MM-DD.json (일별)        │
└──────────────────────────────────────┘
    │
    ▼
[브라우저]
    fetch JSON → 렌더 → localStorage로 체크
```

---

## 2. 아키텍처 결정

### 2.1 왜 GitHub Pages인가

- **사내 방화벽 영향 없음**: 외부 정적 호스팅이라 Nexon 환경에서 접근 자유. morning-brief.github.io가 이미 작동 확인됨.
- **인증 단순**: 페이지 자체는 공개. 콘텐츠가 민감하면 private repo + GitHub Pages는 권한 있는 GitHub 계정에만 노출 가능.
- **백업 자동**: Git 히스토리 자체가 일별 백업.
- **무료**.

### 2.2 왜 Notion DB가 아닌가 (지금은)

7일치 운영에서 모바일 체크 필요성 미확인. 1대 디바이스 사용 패턴이 안정되면 localStorage로 충분. **나중에 모바일 체크가 필요해지면 Notion DB 추가 가능** (사양서 § 8 참조).

### 2.3 왜 vanilla JS인가

GitHub Pages는 빌드 단계가 없는 정적 호스팅. React/Vue를 쓰려면 GitHub Actions 빌드 또는 별도 빌드 워크플로 필요. 단일 HTML 파일 + 외부 폰트 CDN으로 충분히 동작.

---

## 3. JSON 스키마

### 3.1 `data/index.json` — 매니페스트

```json
{
  "version": "1.0",
  "lastUpdated": "2026-06-12T00:30:00+09:00",
  "retentionDays": 14,
  "dates": [
    {
      "date": "2026-06-12",
      "itemCount": 8,
      "highCount": 2,
      "mediumCount": 2,
      "ccCount": 2
    }
  ]
}
```

- `dates`는 최신순. HTML이 이걸 보고 어떤 날짜 JSON이 있는지 안다.

### 3.2 `data/YYYY-MM-DD.json` — 일별 디지스트

```json
{
  "date": "2026-06-12",
  "generatedAt": "2026-06-12T00:30:00+09:00",
  "windowFrom": "2026-06-11T00:30:00+09:00",
  "windowTo": "2026-06-12T00:30:00+09:00",
  "items": [
    {
      "id": "20260611-09",
      "time": "2026-06-11 08:32",
      "chat": "쇼츠 작업방",
      "author": "김찬래 [crkim]",
      "priority": "low",
      "isCC": true,
      "original": "원문 (잘림이면 풀텍스트로 보강됨)",
      "summary": "한 줄 요약",
      "recommend": "권장 코멘트",
      "links": [
        { "label": "Confluence: ...", "url": "https://..." }
      ]
    }
  ],
  "stats": { "total": 8, "high": 2, "medium": 2, "cc": 2 }
}
```

#### `id` 생성 규칙

`YYYYMMDD-NN` 형식. 같은 날짜 안에서 시간 역순으로 01부터.
- 안정성: 같은 메시지면 항상 같은 ID (Power Automate가 Teams `messageId`를 SHA-1 등 해시해서 짧은 형태로 변환하는 것도 옵션)
- 단순성: 현재 JSX 데이터와 같은 형식 유지

#### `priority` 값

| 값 | 의미 | 자동 분류 규칙 |
|---|---|---|
| `high` | 응답 필요 | 직접 멘션 + 의문문/요청 키워드 ("?", "되나요", "확인 부탁", "되는거에여", "어떠심" 등) |
| `medium` | 검토 필요 | 직접 멘션 + 문서/검수/리뷰 키워드 ("검토 부탁", "리뷰", "수정했습니다") |
| `low` | 참고 (cc) | cc 멘션 |
| `info` | 정보성 | 직접 멘션 + 보고/공유/완료 패턴 |
| `casual` | 비업무 | 식사/일정/사적 키워드 ("곱창", "퇴근", "커피") |

#### 특수 필드 (향후 확장)

```json
{
  "messageId": "1781166758112",        // Teams 원본 ID (dedup용)
  "chatId": "19:abc...@thread.v2",     // 채팅방 ID (라벨 매핑용)
  "truncated": false,                  // 본문이 잘렸었는지
  "groupId": "video-revision-v8",      // 연쇄 메시지 묶음
  "isOneOnOne": false,                 // 1:1 채팅 여부
  "reactions": [{ "type": "👍", "byMe": true }],  // 반응 정보
  "attachments": [{ "name": "쇼츠_강화.mp4", "url": "..." }]
}
```

지금 시드 데이터에는 없지만 자동화에서는 채워서 저장. HTML이 점진적으로 활용.

### 3.3 `data/chat-labels.json` — 채팅방 라벨 매핑 (수동 관리)

```json
{
  "19:654f9a74836341538954612587cf1060@thread.v2": "영상 협업방",
  "19:ecd4cc5bfd184a72b9ec7bf76af55745@thread.v2": "스킬젬 협업방",
  "19:270b110c7984434a827bcde8666928aa@thread.v2": "환영열쇠 Cuid방",
  "19:e6a77d01c70f43789798103ea9eb08da@thread.v2": "보상 협의방",
  "19:0cb6e8dafbc4423e982aa199a1c1c057@thread.v2": "왕조의 무덤 협의방",
  "19:52ae7b283c4f4f6ca934b49f415a18b5@thread.v2": "쇼츠 작업방",
  "19:4c04c8d4a9a2406aa26046a337bffd97@thread.v2": "가문 시스템 / 팀 그룹",
  "19:3c39d6b96b2d4344972f6cd599489095@thread.v2": "기획 협업방",
  "19:e160a617a8c2487f808244920ed39e6f@thread.v2": "왕조의 무덤 전투력방"
}
```

7일치 운영에서 자주 등장한 chatId 9개를 시드로 정의. Power Automate가 매번 이 파일 읽어서 매핑. 새 chatId는 자동 폴백 사용 후 본인이 라벨 확정 시 추가.

---

## 4. Power Automate 흐름 사양

### 4.1 트리거

- **유형**: Recurrence
- **주기**: 매일 09:00 KST (Asia/Seoul)
- **타임존**: Seoul Standard Time

### 4.2 단계별 액션

#### Step 1: 변수 초기화

```
- windowEnd = utcNow()
- windowStart = addDays(windowEnd, -1)
- targetDate = formatDateTime(convertFromUtc(windowEnd, 'Korea Standard Time'), 'yyyy-MM-dd')
- mentionedItems = []
```

#### Step 2: Teams 멘션 수집

**액션**: HTTP - Microsoft Graph (Teams 커넥터의 "Search messages"는 mention 필터링이 약함, Graph 직접 호출 권장)

```
POST https://graph.microsoft.com/v1.0/search/query

{
  "requests": [{
    "entityTypes": ["chatMessage"],
    "query": {
      "queryString": "mentions:magicjoel"
    },
    "from": 0,
    "size": 25
  }]
}
```

**중요**:
- `mentions:` KQL이 Graph Search에서 작동하지 않으면 `magicjoel` 키워드로 검색 후 본인 발신 필터링으로 폴백
- 25개 단위 페이지네이션 (`nextOffset`)
- Rate limit (429) 시 지수 백오프: 첫 재시도 2초 → 4초 → 8초, 최대 5회

#### Step 3: 본인 발신 메시지 제외

```
mentionedItems = mentionedItems.filter(m => m.from.userId !== '2185dfaa-243b-4541-ba33-1f223e81ccf9')
```

(magicjoel의 Graph User ID. Step 1에서 한 번만 조회해도 됨)

#### Step 4: 메시지 ID 기반 중복 제거

이전 디지스트(예: 어제 자) JSON을 읽어서 같은 `messageId`가 있으면 제외. 24시간 윈도우가 겹치는 메시지 제거용.

```
prevDigest = fetch('data/' + addDays(targetDate, -1) + '.json')
mentionedItems = mentionedItems.filter(m => !prevDigest.items.some(p => p.messageId === m.id))
```

#### Step 5: 잘린 본문 풀텍스트 보강

`bodyPreview`가 truncated 패턴(말줄임표 `...`, 또는 길이 > 300)이면 메시지 풀텍스트 조회.

```
for each item in mentionedItems:
  if item.bodyPreview.endsWith('...') or item.bodyPreview.length > 300:
    fullMessage = GET https://graph.microsoft.com/v1.0/chats/{chatId}/messages/{messageId}
    item.original = fullMessage.body.content (HTML → 텍스트 변환)
    item.truncated = true
  else:
    item.original = item.bodyPreview
    item.truncated = false
```

#### Step 6: 채팅방 라벨 3단계 폴백

```
chatLabels = fetch('data/chat-labels.json')

for each unique chatId in mentionedItems:
  if chatLabels[chatId]:
    label = chatLabels[chatId]                              // ① 수동 매핑
  else:
    chatInfo = GET https://graph.microsoft.com/v1.0/chats/{chatId}
    if chatInfo.topic:
      label = chatInfo.topic                                // ② topic
    else:
      members = chatInfo.members
      otherNames = members.filter(m => m.userId !== myUserId).map(m => m.displayName).slice(0, 2)
      label = otherNames.join('·')                          // ③ members 조합
```

#### Step 7: 반응(reactions) + 첨부파일 메타 추출

```
for each item:
  item.reactions = fullMessage.reactions.map(r => ({
    type: r.reactionType,
    byMe: r.users.some(u => u.id === myUserId)
  }))
  item.attachments = fullMessage.attachments.map(a => ({ name: a.name, url: a.contentUrl }))
```

cc 메시지에 본인이 이미 따봉 눌렀으면 우선순위 `low` 유지 + UI에서 "이미 처리됨" 표시 가능 (HTML 측에서 사용).

#### Step 8: AI 요약 + 권장 코멘트 + 우선순위 분류

**AI Builder GPT** 또는 **HTTP - Claude API** 액션 사용.

각 item에 대해 다음 프롬프트 호출:

```
[시스템]
You are a PM assistant. Given a Teams mention, output JSON with:
- summary: 한 문장 한국어 요약 (최대 80자)
- recommend: PM이 어떻게 처리해야 할지 권장 코멘트 (한국어, 최대 120자)
- priority: "high" | "medium" | "low" | "info" | "casual"
  · high: 직접 멘션 + 응답 요청 (질문, 결재, 회신 부탁)
  · medium: 직접 멘션 + 검토/리뷰 요청
  · low: cc 멘션
  · info: 직접 멘션 + 정보 공유/완료 통보
  · casual: 식사/일정/사적 잡담

context: PM의 이름은 이민우(magicjoel). Nexon ER 프로젝트 PM.

[유저]
시각: {time}
채팅방: {chat}
작성자: {author}
isCC: {isCC}
원문: {original}

[출력] JSON only.
```

응답 파싱 → item에 summary/recommend/priority 채움.

#### Step 9: 연쇄 메시지 그루핑 (선택)

같은 `chatId` + 30분 이내 + 같은 작성자 패턴이면 같은 `groupId` 부여.

```
groupId = chatId + '-' + roundToHour(time)
```

HTML이 같은 groupId를 묶어서 표시 (펼침/접힘).

#### Step 10: JSON 생성

```
todayJson = {
  date: targetDate,
  generatedAt: nowKST(),
  windowFrom: windowStart,
  windowTo: windowEnd,
  items: mentionedItems,
  stats: { total, high, medium, cc }
}
```

#### Step 11: GitHub Content API로 commit

**액션**: HTTP

```
PUT https://api.github.com/repos/{owner}/mention-brief/contents/data/{targetDate}.json
Authorization: Bearer {GH_PAT}

{
  "message": "data: {targetDate} digest",
  "content": "{base64(todayJson)}",
  "sha": "{existing-sha-if-update}"
}
```

`index.json`도 같은 방식으로 업데이트 (새 날짜 prepend).

#### Step 12: 실패 시 알림

흐름 어느 단계든 실패하면 Teams 본인 채팅(self chat)으로 에러 메시지 발송.

```
액션: Post message in chat (Teams)
대상: 본인
내용: ⚠️ Mention Brief 자동화 실패 - {step} - {error}
```

### 4.3 운영 파라미터

| 항목 | 값 |
|---|---|
| 트리거 시각 | 09:00 KST |
| 윈도우 길이 | 24시간 |
| 최대 메시지 | 100건 (Power Automate 루프 한계 고려) |
| Rate limit 재시도 | 최대 5회, 지수 백오프 |
| AI 모델 | Claude Sonnet 4.6 권장 (정확도/비용 균형) |
| 토큰 비용 | 일평균 ~8-12건 × ~500토큰 = ~5000토큰/일 ≈ $0.05/일 |

---

## 5. AI 프롬프트 템플릿

### 5.1 요약 + 권장 코멘트 + 우선순위 (한 번에)

```
You are a Korean game design PM's assistant. The PM is 이민우 (magicjoel),
working at Nexon on the ER project (MMORPG).

For each Teams mention provided, output strict JSON:
{
  "summary": "한 문장 요약, 80자 이내",
  "recommend": "PM 권장 액션, 120자 이내",
  "priority": "high|medium|low|info|casual"
}

Priority rules:
- high: 직접 멘션 + 명시적 요청/질문 (응답 없으면 작업 블로킹)
- medium: 직접 멘션 + 검토/리뷰 요청 (시간 가용 시 처리)
- low: cc 멘션 (인지만 하면 됨)
- info: 직접 멘션 + 정보 공유/완료 통보 (응답 불필요)
- casual: 비업무 (식사/잡담/일정 친목)

Recommend guidelines:
- 구체적 액션 동사로 시작 (예: "검토 후 회신", "Confluence 3.1 섹션 확인", "팀원 재할당 검토")
- 관련 이전 컨텍스트가 있으면 한 줄로 언급
- 단순 정보성이면 "인지 OK" 정도로 짧게

Output JSON only, no markdown fences.
```

### 5.2 채팅방 라벨 추정 (members 폴백용)

```
Given a Teams group chat with these members (excluding the PM):
- {member1}
- {member2}
- {member3}

And the last 5 messages' main topics:
{recent topics summary}

Generate a 4-8자 Korean label for this chat.
Examples: "영상 협업방", "왕조의 무덤 협의방", "스킬젬 PLC방"

Output the label only, no quotes.
```

(이건 매핑 테이블 보완용. members 단순 조합으로도 충분할 때가 많아 선택적.)

---

## 6. 채팅방 라벨 매핑 시드

7일치 운영에서 본인이 정의한 라벨을 `data/chat-labels.json`의 초기값으로 사용.

```json
{
  "19:654f9a74836341538954612587cf1060@thread.v2": "영상 협업방",
  "19:ecd4cc5bfd184a72b9ec7bf76af55745@thread.v2": "스킬젬 협업방",
  "19:270b110c7984434a827bcde8666928aa@thread.v2": "환영열쇠 Cuid방",
  "19:e6a77d01c70f43789798103ea9eb08da@thread.v2": "보상 협의방",
  "19:0cb6e8dafbc4423e982aa199a1c1c057@thread.v2": "왕조의 무덤 협의방",
  "19:52ae7b283c4f4f6ca934b49f415a18b5@thread.v2": "쇼츠 작업방",
  "19:4c04c8d4a9a2406aa26046a337bffd97@thread.v2": "가문 시스템 / 팀 그룹",
  "19:3c39d6b96b2d4344972f6cd599489095@thread.v2": "기획 협업방",
  "19:e160a617a8c2487f808244920ed39e6f@thread.v2": "왕조의 무덤 전투력방",
  "19:701f2ebfa3004372b50480d00f1d5c58@thread.v2": "튜토리얼 협의방"
}
```

**유지보수**: 새 채팅방이 디지스트에 등장하면 (자동 폴백 라벨로 표시됨) → 본인이 라벨 확정 → `chat-labels.json`에 한 줄 추가하고 commit.

---

## 7. 운영 가이드

### 7.1 일일 점검 (5분)

1. 09:00 디지스트 도착 확인 (브라우저 새로고침)
2. 헤더 카운터 확인: 오늘 N건 / 미확인 M건 / 누적 미해결 K건
3. 응답 필요 항목 위에서부터 처리, 처리 후 체크박스
4. 누적 미해결 섹션 1-2건이라도 처리

### 7.2 주간 점검 (10분)

- `chat-labels.json`에 추가할 채팅방 있는지 확인 → 1줄 commit
- 누적 미해결 > 10건이면 일괄 정리 검토
- 14일 retention 정리되는 항목 확인 (사라지기 전 처리)

### 7.3 자동화 점검

- Power Automate 흐름 실패 알림 → 본인 Teams 채팅으로 도착
- 흐름 실행 이력은 Power Automate UI에서 30일 보관

---

## 8. 향후 확장

### 8.1 Notion DB 동기화 (모바일 체크 필요 시)

- Power Automate 마지막 단계에 "Create row in Notion DB" 추가
- HTML에서 체크 시 Notion API 호출로 동기화 (CORS 우회용 Cloudflare Worker 등 프록시 필요)

### 8.2 본인 발신 메시지 추적

- 본인이 보낸 질문이 응답 받았는지 추적
- 24시간 무응답 시 "내가 보낸 미응답 질문" 별도 섹션

### 8.3 그룹 채팅 reactions 분석

- cc 메시지에 본인 따봉 = 처리 완료로 자동 체크
- "이미 처리됨" 별도 카테고리 표시

### 8.4 알림 통합

- 매일 디지스트 도착 시 Teams 본인 채팅 알림
- 누적 미해결 > 임계치 도달 시 알림

---

## 9. GitHub repo 구조

```
mention-brief/
├── index.html                 (vanilla JS 단일 페이지)
├── data/
│   ├── index.json             (날짜 매니페스트)
│   ├── chat-labels.json       (채팅방 라벨 매핑)
│   └── YYYY-MM-DD.json        (일별 디지스트, Power Automate가 commit)
├── README.md
└── .nojekyll                  (Jekyll 처리 비활성화)
```

### 9.1 초기 셋업

1. GitHub repo 생성 (예: `magicjoel/mention-brief`)
2. Settings → Pages → Source: `main` branch / root
3. 이 사양서의 시드 파일들(`index.html`, `data/index.json`, `data/chat-labels.json`, `data/2026-06-12.json` 등) push
4. GitHub Personal Access Token(PAT) 생성 — `contents:write` 권한
5. Power Automate에 PAT 등록 → 흐름 빌드

### 9.2 Power Automate Premium 라이선스 검토

- HTTP 액션은 Premium 커넥터. 사용자 라이선스 확인.
- 대안: AI Builder + Teams 커넥터(Standard)로 우회 가능하지만 mention 필터링이 제한적.

---

## 10. 메모

- 6일치 운영 데이터 자체가 가치 있는 자산. `data/2026-05-14.json` ~ `data/2026-06-12.json` 7일치 시드를 함께 제공.
- 자동화 운영 시작 후 첫 2주 내 발견되는 새 패턴은 § 8 향후 확장에 추가.

---

**End of Spec v1.0**
