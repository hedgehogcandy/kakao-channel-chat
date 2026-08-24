# kakao-channel-chat

> **비공식(Unofficial).** 카카오 채널 관리자센터(비즈니스 채팅, 내부 코드명 "rocket")의 **문서화되지 않은 내부 API**를 리버스 엔지니어링한 것입니다. 카카오의 공식 제품이 아니며, 스펙이 예고 없이 바뀌어 깨질 수 있고 카카오 이용약관에 저촉될 수 있습니다. **본인 소유 채널의 자동화 용도로, 책임 하에 사용하세요.** 자세한 건 [DISCLAIMER](./DISCLAIMER.md).

로그인된 브라우저 세션을 그대로 재사용해 **카카오 채널 채팅**을 코드로 다루는 Node 툴킷.
**API 라이브러리 · CLI · MCP 서버** 세 가지 형태로 제공합니다. 외부 런타임 의존성은 MCP SDK 하나뿐(라이브러리/CLI는 의존성 0).

## 되는 것

- ✅ **로그인 상태 확인** & **토큰 무한 리프레시** (세션 안 끊김)
- ✅ **채팅방 리스트** + 읽음/안읽음 구분 + 방 딥링크
- ✅ **대화내역** 조회 (우리/고객/시스템 메시지 구분, 링크 추출)
- ✅ **읽음 처리**, **메시지 전송**(답장)
- ✅ **실시간 신규 메시지 감시** (SSE / 폴링)
- ✅ **상시 데몬** (토큰 자동갱신 + keepalive + 감시 + 선택적 자동응답)
- ✅ **MCP 서버** — Claude/Cursor 등에서 툴로 사용

## 동작 원리

카카오 채널 채팅 API(`business.kakao.com/api/*`)는 **kakao 로그인 쿠키만으로 인증**됩니다(별도 토큰 불필요). 이 툴은 유효한 kakao 세션 쿠키를 확보해 그 API를 그대로 호출합니다. 리버스한 엔드포인트 전체 맵은 [API.md](./API.md) 참고.

### 인증 방식 3가지 (하나 선택)

**1) macOS + Chrome 자동추출 (기본)**
Chrome에 대상 채널로 로그인만 돼 있으면, 쿠키 저장소에서 세션을 자동 추출(HttpOnly 포함). 별도 설정 불필요.
```bash
node bin/kbc.js whoami   # 그냥 실행하면 됨(macOS)
```

**2) Playwright 자체 로그인 (크로스플랫폼 · 헤드리스 · 권장)**
도구가 **자체 브라우저로 로그인**하고 세션을 보유 → macOS가 아니어도, 서버에서도 동작. 2FA/캡차는 최초 1회만 직접 처리.
```bash
npm i playwright && npx playwright install chromium
node bin/kbc.js login          # 브라우저가 열림 → 카카오 로그인(2FA 포함) → 세션 저장
KBC_AUTH=playwright node bin/kbc.js whoami   # 이후 저장된 세션 사용
```
- 세션은 `.kbc-auth/state.json`(gitignore)에 저장. `daemon`이 주기적으로 사이트를 터치해 **세션을 안 풀리게** 유지.
- **자동 재로그인**: 세션이 완전히 풀리면 데몬이 감지 → 로그인 브라우저를 다시 띄움(2FA만 직접 처리) → 자동 복구. 헤드리스/서버면 `kbc login`을 다시 실행하면 데몬이 새 세션을 자동으로 주워 재시작 없이 복구.

**3) 쿠키 직접 주입**
```bash
KBC_COOKIE="_kawlt=...; _kawltea=...; ..." node bin/kbc.js whoami
```
(브라우저 DevTools → Network → 요청의 Cookie 헤더 복사, 또는 "Copy as cURL")

## 요구사항

- Node ≥ 20.12
- **쿠키 자동추출**을 쓰려면: macOS + Google Chrome에 대상 카카오 채널 **로그인 상태**
  (내부적으로 `/usr/bin/sqlite3` + Keychain 사용, macOS 기본 탑재)
- 다른 OS/브라우저: `KBC_COOKIE` 수동 주입으로 사용 가능

## 설치

```bash
git clone <this-repo>
cd kakao-channel-chat
npm install
cp .env.example .env      # KBC_PROFILE_ID 채워넣기
```

`.env`:
```
KBC_PROFILE_ID=_XXXXX     # 관리자센터 URL business.kakao.com/{이값}/chats 의 {이값}
# KBC_CHROME_PROFILE=Default   # (선택) 여러 Chrome 프로필 중 지정. 미지정 시 자동탐지
# KBC_COOKIE=...               # (선택) 쿠키 자동추출 대신 직접 주입
```

## CLI 사용법

```bash
node bin/kbc.js whoami                 # 로그인 상태
node bin/kbc.js token                  # 토큰 리프레시(무한로그인 확인)
node bin/kbc.js unread                 # 안읽은 방 (링크 포함)
node bin/kbc.js list --json            # 전체 방 (JSON)
node bin/kbc.js logs <chatId>          # 대화내역
node bin/kbc.js mark <chatId>          # 읽음 처리
node bin/kbc.js send <chatId> "<text>" --yes    # ⚠️ 실제 발송
node bin/kbc.js watch --poll           # 실시간 감시
node bin/kbc.js daemon                  # 상시 구동(토큰 무한유지+감시)
node bin/kbc.js daemon --autoreply      # + 안읽은 새 메시지 자동응답
```

## 라이브러리 사용

```js
import { KakaoBizChatClient } from './src/client.js';

const c = new KakaoBizChatClient({ profileId: process.env.KBC_PROFILE_ID }); // 쿠키 자동
if ((await c.checkLogin()).loggedIn) {
  const unread = await c.getUnreadChats();               // is_read=false 방들 (+ .link)
  const { items } = await c.getChatlogs(unread[0].id);   // 대화내역 (.from = 'us'|'customer')
  await c.markRead(unread[0].id);
  // await c.sendText(unread[0].id, '답장');              // ⚠️ 실발송
}
```

실시간 감시:
```js
import { watchPolling, watchSSE } from './src/push.js';
watchPolling(c, { onMessage: ({ chat }) => console.log('새 메시지', chat.name, chat.last_message) });
```

## MCP 서버

Claude Code / Claude Desktop / Cursor 등의 MCP 설정에 추가:

```json
{
  "mcpServers": {
    "kakao-channel": {
      "command": "node",
      "args": ["/absolute/path/to/kakao-channel-chat/src/mcp-server.js"],
      "env": {
        "KBC_PROFILE_ID": "_XXXXX",
        "KBC_CHROME_PROFILE": "Default"
      }
    }
  }
}
```

노출 툴: `kakao_login_status`, `kakao_unread_count`, `kakao_list_chats`, `kakao_get_chat`, `kakao_get_messages`, `kakao_mark_read`.
**발송 툴**(`kakao_send_message`)은 안전상 기본 비활성 — `KBC_MCP_ALLOW_SEND=1` 을 env에 추가하면 노출됩니다.

## 상시 구동 (PM2)

토큰을 만료 전 자동 갱신하고 세션을 살려둬 **끊기지 않게** 돌립니다. 크래시 시 자동 재시작:

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 logs kakao-channel
pm2 save && pm2 startup   # 부팅 시 자동 실행
```

> macOS 쿠키 자동추출 방식은 **Chrome이 로그인 상태로 유지**돼야 세션이 무한 유지됩니다(Chrome이 쿠키를 자동 갱신). Chrome 없이 완전 헤드리스로 돌리려면 `KBC_COOKIE` 를 주기적으로 갱신하거나 kakao SSO refresh 흐름을 별도 구현해야 합니다.

## 보안 / 주의

- 쿠키·토큰은 **로컬에만** 존재하며 외부로 전송하지 않습니다.
- `.env` 와 쿠키는 절대 커밋하지 마세요(`.gitignore`에 포함됨).
- `send`/`--autoreply` 는 **실제 고객에게 즉시 전달**됩니다.
- 본인 소유 채널에만 사용하세요.

## 라이선스

MIT — [LICENSE](./LICENSE). 카카오/KakaoTalk 은 Kakao Corp.의 상표이며 본 프로젝트와 무관합니다.
