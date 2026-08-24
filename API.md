# 카카오 채널(비즈니스 채팅 / 관리자센터, 내부명 "rocket") 비공식 API 맵

> 로그인된 관리자센터 세션의 네트워크 트래픽에서 도출한 **비공식** 리버스 문서.
> `{profileId}` = 채널 프로필ID (관리자센터 URL `business.kakao.com/{profileId}/chats` 의 값, 예: `_XXXXX`).
> 카카오 공식 문서가 아니며 예고 없이 변경될 수 있음.

## 1. 인증 구조

| 도메인 | 인증 방식 | 비고 |
|---|---|---|
| `business.kakao.com/api/*` | **쿠키 세션만** (kakao SSO 쿠키, HttpOnly) | 채팅 기능 전부 여기. Bearer 불필요 |
| `crux-bizgateway.kakao.com/*` | `Authorization: Bearer <JWT>` | GNB 알림/pusher 등 부가기능. JWT 수명 1시간 |

- **핵심 쿠키**: `_kawlt`, `_kawltea`, `_karmt`, `_kadu`, `_kau` 등 (HttpOnly → JS `document.cookie`로 못 읽음). 브라우저 쿠키 저장소에서 추출해야 함.
- **커스텀 헤더**: 채팅 API는 `X-Kakao-RocketApiVersion` 을 붙임(관측값 예: `19`).
- **CORS**: credentialed. 서버-사이드(Node) 호출은 CORS 무관.

### 무한 로그인 (토큰 리프레시)
```
POST https://crux-bizgateway.kakao.com/auth/login/dsp
Content-Type: application/json
Body: {}          (쿠키로 인증)
→ 200 { "accessToken": "<JWT, exp = now+1h>" }   (응답 헤더 x-access-token 에도 동일)
```
- 호출할 때마다 exp가 미래로 갱신된 새 JWT 발급 → **쿠키가 살아있는 한 무한 재발급**.
- kakao SSO 쿠키 자체도 `_kawltea`(refresh)로 브라우저가 자동 갱신. 스탠드얼론에서는 브라우저 쿠키를 주기적으로 다시 읽으면 무한 유지.

## 2. 로그인 유무
```
GET https://business.kakao.com/api/users/me
→ 200 { account_id, name, email, tel, id, is_tfa_enabled, ... }   (401/리다이렉트면 로그아웃)
```

## 3. 채팅방 리스트 (읽음/안읽음 구분)
```
POST https://business.kakao.com/api/profiles/{profileId}/chats/search?size=100
Content-Type: application/json
X-Kakao-RocketApiVersion: 19
Body: { "is_blocked": false, "status": "progress", "keyword": "", "labels": [] }
→ 200 { "items": [ <ChatRoom> ], "has_next": bool }
```
- `status`: `"progress"`(진행중) | `"done"`(완료). `keyword`로 검색, `labels`로 라벨 필터.
- **ChatRoom 주요 필드**:
  - `id` — 채팅방 ID (= `talk_user.chat_id`)
  - `name` / `talk_user.nickname` — 상대 이름
  - `last_message` — 마지막 메시지 미리보기
  - **`is_read`** — 읽음 여부 (false=안읽음)
  - **`unread_count`** — 안읽은 개수
  - `is_replied` — 우리가 답장했는지 / `is_done` — 상담 완료
  - `last_log_id` / `last_seen_log_id` / `user_last_seen_log_id` — 로그 커서(읽음처리·페이징)
  - `updated_at`, `last_log_send_at` — 갱신/마지막 로그 발신 시각(ms epoch), `version` — 서버 갱신 버전(신규감지용)
  - `assignee_id`, `chat_label_ids`, `is_starred`, `is_blocked`, `is_friend`
- **방 웹 딥링크**: `https://business.kakao.com/{profileId}/chats/{id}`

### 안읽음 카운트만
```
GET https://business.kakao.com/api/profiles/{profileId}/counts
→ { "unread": <n>, "id": "{profileId}" }
```

## 4. 채팅방 상세 진입
```
GET https://business.kakao.com/api/profiles/{profileId}/chats/{chatId}?isEnterChatRoom=true
→ 200 <ChatRoom + chat_key, add_msg_layer_status, check_add_friend_message>
```

## 5. 대화내역 (conversation history)
```
GET https://business.kakao.com/api/profiles/{profileId}/chats/{chatId}/chatlogs
GET .../chatlogs?since={logId}&direction=backward     # 과거 페이지네이션
GET .../chatlogs?since={logId}&direction=forward      # 이후
→ 200 { "has_prev": bool, "has_next": bool, "items": [ <ChatLog> ] }
```
- **ChatLog 주요 필드**:
  - `id` — 로그 ID (snowflake, 시간순 정렬 가능)
  - `message` — 본문 텍스트
  - `type` — `1`=텍스트, `71`=시스템/자동응답(운영시간 안내 등), 그 외 이미지/파일/피드
  - `author_id` — 보낸 주체. **`{chatId}_tuser`=고객**, **`{profileId}`=채널(우리)**
  - `author.user_type` — `0`=고객, `1`=채널(우리)
  - `manager: {id, name}` — 우리 쪽 메시지일 때 담당 매니저
  - `send_at`, `prev_id`, `attachment` (링크는 `attachment.urls: [...]`)

## 6. 읽음 처리
```
GET https://business.kakao.com/api/profiles/{profileId}/chats/{chatId}/chatlogs/mark?lastSeenLogId={logId}
→ 204
```
- `lastSeenLogId` = 그 방의 최신 `last_log_id`로 주면 완전 읽음 처리.

## 7. 메시지 전송 (답장)  ⚠️ 실제 발송됨
```
POST https://business.kakao.com/api/profiles/{profileId}/chats/{chatId}/chatlogs
Content-Type: multipart/form-data
FormData:
  text = "<보낼 메시지>"                     # 텍스트
  # 또는 image=<blob>, width, height, mimetype  # 사진
  # 또는 file=<blob>, fileSize, fileName        # 파일
→ 200 <생성된 ChatLog>
```
- 와이어 요청 바디에는 `text` 필드만 필요(클라이언트 내부의 optimistic `unique`(uuid)는 전송 안 함).

## 8. 기타 REST
- `GET /api/profiles/{profileId}/chats/consult` — 상담 설정(운영시간·AI모드·응답률 등)
- `GET /api/profiles/{profileId}/chat_labels` — 라벨 목록
- `GET /api/profiles/{profileId}/managers` — 매니저 목록
- `DELETE /api/profiles/{profileId}/chats/{chatId}/chatlogs/{logId}` — 메시지 삭제
- `POST /api/profiles/{profileId}/chats/{chatId}/chatlogs/{logId}/scrap` — 링크 미리보기 스크랩

## 9. 실시간/푸시 (알람 캐치) — 3채널

### A. SSE (권장, 가장 단순)
```
GET https://business-proxy.kakao.com/api/public/notification/events
Accept: text/event-stream
(쿠키 인증, 롱리브 스트림)
```

### B. STOMP over SockJS (실시간 채팅 메시지 원본)
```
GET https://pf-capi.kakao.com/ws/info?t={ts}   → { websocket:true, cookie_needed:true, ... }
SockJS 엔드포인트: https://pf-capi.kakao.com/ws   → 그 위에서 STOMP(Stomp.over(sockjs)) 구독.
```

### C. FCM 웹푸시 (브라우저 알림)
```
POST https://crux-bizgateway.kakao.com/kakaobusiness/biz-platform/v1/pusher/token
Authorization: Bearer <JWT>
Body: { "pushType":"WEB", "pushToken":"<FCM endpoint>" }
```
- 헤드리스 가로채기엔 부적합 → A/B로 대체.

### 폴링 폴백
3~5초 간격으로 `chats/search`(또는 `/counts`)를 재호출해 `version`/`unread_count` 변화로 신규 감지(가장 확실).
