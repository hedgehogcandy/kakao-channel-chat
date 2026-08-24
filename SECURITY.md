# 보안 / Security

이 도구가 **무엇에 접근하고**, **무엇을 하지 않는지** 투명하게 밝힙니다.
한 줄 요약: **모든 데이터는 로컬에만 있고, 통신은 카카오 서버로만 갑니다. 제3자로 아무것도 보내지 않습니다.**

---

## 무엇에 접근하나 (What it accesses)

인증 방식에 따라 다릅니다(하나만 사용).

| 방식 | 접근 대상 | 이유 |
|---|---|---|
| **macOS Chrome 자동추출** | Chrome 쿠키 DB(`~/Library/.../Chrome/<Profile>/Cookies`) + macOS Keychain의 `Chrome Safe Storage` 키 | Chrome이 암호화해 저장한 kakao 세션 쿠키를 복호화해 읽기 위함 |
| **Playwright 자체 로그인** | 도구가 띄운 브라우저의 세션(`​.kbc-auth/state.json`) | 자체 브라우저로 로그인한 세션을 저장/재사용. **Keychain·Chrome 안 건드림** |
| **쿠키 직접 주입** | 사용자가 넘긴 `KBC_COOKIE` 문자열 | 아무것도 자동으로 안 읽음 |

- 실행 중 외부 바이너리는 `/usr/bin/security`(Keychain 조회)와 `/usr/bin/sqlite3`(쿠키 DB 읽기) **딱 둘**뿐이며, 모두 **배열 인자로 호출(쉘 인젝션 불가)**, 절대경로 고정입니다.

## 무엇을 하지 않나 (What it does NOT do)

- ❌ **쿠키·토큰·세션을 외부로 전송하지 않습니다.** 네트워크 요청 대상은 **카카오 도메인뿐**입니다:
  `business.kakao.com`, `crux-bizgateway.kakao.com`, `business-proxy.kakao.com`, `accounts.kakao.com`(로그인 시).
- ❌ 텔레메트리·애널리틱스·원격 로깅 없음.
- ❌ `npm install` 시 실행되는 스크립트 없음(postinstall 등 0). `eval`/원격코드 실행 없음.
- ❌ 자격증명을 코드에 하드코딩하지 않음. 저장소에 실제 쿠키/토큰/계정정보 없음.

## 자격증명은 어디에 저장되나 (Where credentials live)

- 전부 **로컬에만** 존재합니다. 저장소로 커밋되지 않도록 `.gitignore`에 다음이 포함되어 있습니다: `.env`, `.kbc-auth/`, `*.log`.
- **주의**: Playwright 세션 파일 `.kbc-auth/state.json` 에는 세션 쿠키가 **평문**으로 들어있습니다(이런 종류 도구의 불가피한 특성). 이 파일과 `.env`의 파일 권한을 본인만 읽도록 관리하세요(`chmod 600`). 공유·커밋 금지.
- crux Bearer 토큰은 **메모리에만** 보관하며 디스크에 캐시하지 않습니다.

## 발송 안전장치 (Send safeguards)

실제 고객에게 메시지가 나가는 기능은 **기본 비활성**입니다.
- CLI `send` → `--yes` 필수. `autoreply` → `--send --yes` 필수.
- MCP `kakao_send_message` → `KBC_MCP_ALLOW_SEND=1` 일 때만 노출.
- daemon 자동응답 → 기본 off.

## 책임 있는 사용 / 법적 고지 (Responsible use)

- **본인이 소유/관리 권한을 가진 카카오 채널**에만 사용하세요. 타인 계정 접근·무단 크롤링·스팸 발송 금지.
- 이 도구는 **비공식**이며 카카오의 문서화되지 않은 내부 API를 사용합니다. 사용이 카카오 **이용약관에 저촉될 수 있으며**, 그 책임은 사용자에게 있습니다. [DISCLAIMER](./DISCLAIMER.md) 참고.

## 취약점 제보 (Reporting)

보안 이슈를 발견하면 공개 이슈 대신 저장소의 **Security Advisory**(Security 탭 → Report a vulnerability)로 알려주세요.

---

_This tool keeps all data local and only talks to Kakao's own servers. It never sends your cookies, tokens, or session to any third party. No install scripts, no telemetry, no remote code. Use only on channels you own; this is an unofficial tool that may violate Kakao's ToS — use at your own risk._
