# Mention Brief

Nexon ER 프로젝트 PM의 Teams 멘션 일별 디지스트. 매일 09:00 KST Power Automate가 지난 24시간 멘션을 수집·요약·분류해 JSON으로 GitHub에 commit, GitHub Pages가 정적 서빙.

## 구조

```
mention-brief/
├── index.html              # vanilla JS 단일 페이지
├── automation-spec.md      # Power Automate 흐름 사양서
├── data/
│   ├── index.json          # 날짜 매니페스트 (Power Automate가 매일 업데이트)
│   ├── chat-labels.json    # 채팅방 라벨 매핑 (수동 관리)
│   └── YYYY-MM-DD.json     # 일별 디지스트 (Power Automate가 매일 commit)
└── .nojekyll               # Jekyll 처리 비활성화
```

## 셋업

1. 이 디렉토리를 GitHub repo로 push (예: `magicjoel/mention-brief`)
2. Settings → Pages → Source: `main` branch / `/` (root)
3. 약 1분 후 `https://magicjoel.github.io/mention-brief/` 접근
4. Power Automate 흐름은 `automation-spec.md` 참조해서 빌드
5. GitHub Personal Access Token(PAT) 생성 (`contents:write` 권한) → Power Automate에 등록

## 로컬 테스트

```bash
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000 접속
```

`file://` 직접 열기는 fetch CORS 때문에 동작 안 함. 반드시 HTTP 서버 통해서 열기.

## 데이터 시드

7일치 운영 데이터(58건)가 `data/` 안에 시드로 포함됨. Power Automate 첫 실행 전이라도 페이지가 정상 동작합니다.

## 운영

- 매일 09:00 KST: Power Automate가 새 `data/YYYY-MM-DD.json` commit + `data/index.json` 갱신
- 브라우저: 새로고침하면 최신 디지스트 표시
- 체크 상태: 브라우저 localStorage (`mention-brief:checks`)에 저장 — 1대 디바이스 한정
- 14일 지난 해결된 건은 자동으로 표시에서 제외 (스토리지는 보존)

## 채팅방 라벨 추가

새 채팅방이 디지스트에 등장하면 (자동 폴백 라벨로 표시됨) → 본인이 라벨 확정 → `data/chat-labels.json`에 추가 commit.

## 자동화 사양

`automation-spec.md` 참조.
