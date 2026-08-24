#!/usr/bin/env node
// kbc — 카카오 채널(비즈니스 채팅) CLI
import { KakaoBizChatClient } from '../src/client.js';
import { watchSSE, watchPolling } from '../src/push.js';
import { runDaemon } from '../src/daemon.js';

// 로컬 .env 로드(있으면). 시크릿/프로필ID는 여기서 관리(gitignore 대상).
try { process.loadEnvFile(); } catch { /* .env 없으면 무시 */ }

const PW_STATE = process.env.KBC_PW_STATE || '.kbc-auth/state.json';
const USE_PLAYWRIGHT = process.env.KBC_AUTH === 'playwright';

const PROFILE_ID = process.env.KBC_PROFILE_ID;
function requireProfile() {
  if (!PROFILE_ID) {
    console.error('오류: KBC_PROFILE_ID 가 필요합니다. 채널 프로필ID를 .env 또는 환경변수로 지정하세요.');
    console.error('  예) echo \'KBC_PROFILE_ID=_XXXXX\' >> .env   (채널 관리자센터 URL business.kakao.com/{이값}/chats)');
    process.exit(1);
  }
}
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const pos = argv.slice(1).filter((a) => !a.startsWith('--'));
const has = (f) => flags.has(f);

async function makeClient() {
  // 인증 소스 우선순위: KBC_AUTH=playwright > KBC_COOKIE(고정) > Chrome 자동추출(macOS)
  let cookieProvider = null;
  if (USE_PLAYWRIGHT) {
    const { makeStateProvider } = await import('../src/auth-playwright.js');
    cookieProvider = makeStateProvider(PW_STATE);
  }
  return new KakaoBizChatClient({
    profileId: PROFILE_ID,
    cookieProvider,
    cookieHeader: process.env.KBC_COOKIE || null,
    profileHint: process.env.KBC_CHROME_PROFILE || null,
  });
}

const ts = (ms) => new Date(ms).toLocaleString('ko-KR', { hour12: false });
const j = (o) => JSON.stringify(o, null, 2);

const HELP = `kbc — 카카오 채널(비즈니스 채팅) CLI

명령:
  login [--headless]    Playwright 브라우저로 카카오 로그인 → 세션 저장(크로스플랫폼)
  whoami                로그인 상태 확인
  token [--full]        토큰 강제 리프레시(무한로그인 확인)
  counts                안읽음 카운트
  list [--done] [--unread] [--json]   채팅방 리스트
  unread                안읽은 방만
  chat <chatId>         방 상세(JSON)
  logs <chatId> [--json]   대화내역
  mark <chatId> [logId]    읽음 처리
  send <chatId> <text> --yes   ⚠️ 실제 발송
  watch [--poll] [--json]      실시간 알람 감시(SSE/폴링)
  autoreply [--send --yes]     안읽은 방 자동응답(기본 dry-run)
  daemon [--autoreply]         상시 구동(토큰 무한유지+감시, PM2 권장)

설정(.env 또는 환경변수):
  KBC_PROFILE_ID    채널 프로필ID (business.kakao.com/{이값}/chats)  [필수]
  KBC_AUTH          인증 방식: playwright (지정 시 저장된 세션 사용, 크로스플랫폼)
  KBC_PW_STATE      Playwright 세션 파일 경로 (기본 .kbc-auth/state.json)
  KBC_CHROME_PROFILE  Chrome 프로필명(Default, "Profile 1"...)   [선택, macOS 자동추출]
  KBC_COOKIE        고정 Cookie 헤더(미지정 시 Chrome 쿠키 자동추출)
  KBC_REPLY         autoreply/daemon 기본 답장 템플릿
  KBC_AUTOREPLY     daemon 자동응답 on(1)

인증 방식 3가지:
  1) macOS Chrome 자동추출 (기본)   — Chrome에 로그인만 돼있으면 됨
  2) KBC_AUTH=playwright          — 'kbc login' 1회 후 크로스플랫폼/헤드리스
  3) KBC_COOKIE=...               — Cookie 헤더 직접 주입`;

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }

  // login 은 계정 단위 — 프로필/클라이언트 불필요. Playwright 브라우저로 대화형 로그인.
  if (cmd === 'login') {
    const { loginInteractive } = await import('../src/auth-playwright.js');
    await loginInteractive({ statePath: PW_STATE, headless: has('--headless') });
    console.log(`✅ 세션 저장됨: ${PW_STATE}\n  이제 KBC_AUTH=playwright 로 모든 명령을 크로스플랫폼으로 쓸 수 있습니다.`);
    return;
  }

  requireProfile();
  const c = await makeClient();
  switch (cmd) {
    case 'whoami':
    case 'login': {
      const r = await c.checkLogin();
      if (has('--json')) return console.log(j(r));
      if (r.loggedIn) console.log(`✅ 로그인됨 — ${r.user.name} (${r.user.email}) / account_id=${r.user.account_id} / Chrome프로필=${c.chromeProfile}`);
      else console.log(`❌ 로그아웃 상태: ${r.error}`);
      break;
    }
    case 'token': {
      const t = await c.refreshToken();
      const exp = c._token.exp;
      console.log(`🔑 새 토큰 발급 — exp=${ts(exp * 1000)} (${exp - Math.floor(Date.now() / 1000)}초 남음)`);
      if (has('--full')) console.log(t);
      break;
    }
    case 'counts': {
      console.log(j(await c.getCounts()));
      break;
    }
    case 'list':
    case 'unread': {
      const status = has('--done') ? 'done' : 'progress';
      let list = await c.listChats({ status });
      if (cmd === 'unread' || has('--unread')) list = list.filter((x) => !x.is_read);
      if (has('--json')) return console.log(j(list));
      console.log(`총 ${list.length}방 (status=${status})`);
      for (const x of list) {
        const mark = x.is_read ? '  ' : '🔴';
        const rep = x.is_replied ? '↩︎' : '  ';
        console.log(`${mark}${rep} [${x.id}] ${(x.name || '').padEnd(14).slice(0, 14)} u=${x.unread_count} ${ts(x.last_log_send_at)}`);
        console.log(`        ${(x.last_message || '').replace(/\n/g, ' ').slice(0, 60)}`);
        console.log(`        ${x.link}`);
      }
      break;
    }
    case 'chat': {
      const chat = await c.getChat(pos[0]);
      console.log(j(chat));
      break;
    }
    case 'logs': {
      const chatId = pos[0];
      if (!chatId) throw new Error('사용법: kbc logs <chatId>');
      const { items } = await c.getChatlogs(chatId);
      if (has('--json')) return console.log(j(items));
      for (const m of items) {
        const who = m.from === 'us' ? '나 ' : '👤';
        const sys = m.isSystem ? '[시스템] ' : '';
        console.log(`${ts(m.send_at)} ${who} ${sys}${(m.message || '').replace(/\n/g, ' ')}`);
        for (const l of m.links) console.log(`             ↳ ${l}`);
      }
      break;
    }
    case 'mark': {
      const r = await c.markRead(pos[0], pos[1] || null);
      console.log(`✅ 읽음처리: ${j(r)}`);
      break;
    }
    case 'send': {
      const chatId = pos[0];
      const text = pos.slice(1).join(' ');
      if (!chatId || !text) throw new Error('사용법: kbc send <chatId> <text...> --yes');
      if (!has('--yes')) {
        console.log(`⚠️  실제 고객에게 발송됩니다. 확인하려면 --yes 를 붙이세요.`);
        console.log(`   방=${chatId}\n   내용="${text}"`);
        return;
      }
      const r = await c.sendText(chatId, text);
      console.log(`✅ 전송됨 — logId=${r?.id} @ ${ts(r?.send_at)}`);
      break;
    }
    case 'watch': {
      console.log(`👀 실시간 감시 시작 (${has('--poll') ? '폴링' : 'SSE'}) — Ctrl+C 종료`);
      if (has('--poll')) {
        const w = watchPolling(c, {
          onMessage: ({ chat }) => {
            console.log(`\n🔔 새 메시지 — [${chat.id}] ${chat.name} (안읽음 ${chat.unread_count})`);
            console.log(`   ${(chat.last_message || '').replace(/\n/g, ' ').slice(0, 80)}`);
            console.log(`   ${chat.link}`);
          },
          onError: (e) => console.error('폴링 오류:', e.message),
        });
        process.on('SIGINT', () => { w.stop(); process.exit(0); });
        await w.done;
      } else {
        const w = watchSSE(c,
          (ev) => console.log(`🔔 [${ev.event}] ${has('--json') ? j(ev.json ?? ev.data) : (ev.data || '').slice(0, 200)}`),
          { onError: (e) => console.error('SSE 오류:', e.message) });
        process.on('SIGINT', () => { w.stop(); process.exit(0); });
        await w.done;
      }
      break;
    }
    case 'autoreply': {
      // 안읽은 방에 대해 답장을 "계획"만 하고 기본은 dry-run. 실제 발송은 --send --yes 동시 필요.
      const template = process.env.KBC_REPLY || '안녕하세요! 확인 후 빠르게 답변드리겠습니다 🙌';
      const unread = await c.getUnreadChats();
      console.log(`안읽은 방 ${unread.length}개.`);
      const doSend = has('--send') && has('--yes');
      for (const x of unread) {
        console.log(`\n[${x.id}] ${x.name} — "${(x.last_message || '').slice(0, 40)}"`);
        console.log(`  → 답장안: "${template}"`);
        if (doSend) {
          const r = await c.sendText(x.id, template);
          await c.markRead(x.id);
          console.log(`  ✅ 발송+읽음 (logId=${r?.id})`);
        } else {
          console.log(`  (dry-run — 실제 발송하려면 --send --yes)`);
        }
      }
      break;
    }
    case 'daemon': {
      let reauth = null;
      if (USE_PLAYWRIGHT) {
        // Playwright 모드: 세션 유지 keepAlive + 끊김 시 자동 재로그인.
        const { keepAlive, loginInteractive } = await import('../src/auth-playwright.js');
        await keepAlive({ statePath: PW_STATE, headless: !has('--headed'), onError: (e) => console.error('keepAlive:', e.message) });
        console.log('🌐 Playwright 세션 keepAlive 시작 — 세션을 주기적으로 갱신합니다.');
        // 세션이 완전히 풀리면 로그인 브라우저를 다시 띄워 2FA만 처리하면 복구.
        reauth = () => loginInteractive({ statePath: PW_STATE, headless: false });
      }
      await runDaemon(c, {
        autoReply: has('--autoreply') || process.env.KBC_AUTOREPLY === '1',
        replyText: process.env.KBC_REPLY || undefined,
        reauth,
      });
      break;
    }
    default:
      console.log(`알 수 없는 명령: ${cmd}\n`);
      console.log(HELP);
  }
}

main().catch((e) => { console.error('오류:', e.message); process.exit(1); });
