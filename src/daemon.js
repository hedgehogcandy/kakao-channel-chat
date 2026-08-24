// 상시 구동 데몬: "절대 안 끊김" + 신규 메시지 감시(+선택 자동응답).
//  - 토큰: 만료 전(기본 exp-5분) 자동 리프레시 → crux Bearer 무한 유지
//  - 세션 keepalive: 주기적으로 /users/me 터치 + Chrome 쿠키 재로딩 → SSO 세션 살아있게
//  - 감시: 폴링으로 신규 고객 메시지 캐치, 옵션이면 자동응답+읽음
//  - 하트비트: 살아있음 로그, 로그아웃 감지 시 경보+재시도
import { watchPolling } from './push.js';
import { AuthError } from './client.js';

const now = () => new Date();
const stamp = () => now().toLocaleString('ko-KR', { hour12: false });
const maskEmail = (e) => (e || '').replace(/^(.{1,3}).*(@.*)$/, '$1***$2');
function log(level, msg) {
  const line = `${stamp()} [${level}] ${msg}`;
  console.log(line);
}

export async function runDaemon(client, {
  pollMs = 5000,             // 신규메시지 폴링 간격
  keepaliveMs = 10 * 60_000, // 세션 터치 주기(10분)
  heartbeatMs = 15 * 60_000, // 하트비트 주기(15분)
  tokenSkewMs = 5 * 60_000,  // 토큰 만료 몇 분 전에 리프레시(5분)
  autoReply = false,         // 자동응답 여부
  replyText = '안녕하세요! 확인 후 빠르게 답변드리겠습니다 🙌',
  status = 'progress',
  onMessage = null,
} = {}) {
  let stopped = false;
  const timers = [];
  const clear = () => { for (const t of timers) clearTimeout(t); };

  // --- 0) 기동: 로그인 확인 + 첫 토큰 ---
  const lg = await client.checkLogin();
  if (!lg.loggedIn) throw new AuthError(`기동 실패 — 로그아웃 상태입니다. Chrome에서 business.kakao.com 로그인 필요. (${lg.error})`);
  log('INFO', `데몬 기동 — ${lg.user.name} (${maskEmail(lg.user.email)}) / 프로필=${client.profileId} / 세션=${client.chromeProfile}`);
  await client.refreshToken();
  log('INFO', `초기 토큰 발급 — exp=${new Date(client._token.exp * 1000).toLocaleString('ko-KR', { hour12: false })}`);
  log('INFO', `설정 — poll=${pollMs / 1000}s keepalive=${keepaliveMs / 60000}m heartbeat=${heartbeatMs / 60000}m autoReply=${autoReply ? 'ON' : 'OFF'}`);

  // --- 1) 토큰 자동 리프레시 스케줄러 (만료 전) ---
  const scheduleTokenRefresh = () => {
    if (stopped) return;
    const msLeft = client._token.exp * 1000 - Date.now() - tokenSkewMs;
    const delay = Math.max(30_000, msLeft); // 최소 30초 뒤
    const t = setTimeout(async () => {
      if (stopped) return;
      try {
        await client.refreshToken();
        log('INFO', `🔑 토큰 갱신 — exp=${new Date(client._token.exp * 1000).toLocaleString('ko-KR', { hour12: false })}`);
      } catch (e) {
        log('WARN', `토큰 갱신 실패: ${e.message} — 60초 후 재시도`);
        const rt = setTimeout(() => scheduleTokenRefresh(), 60_000); timers.push(rt);
        return;
      }
      scheduleTokenRefresh();
    }, delay);
    timers.push(t);
    log('INFO', `다음 토큰 갱신 예약 — ${Math.round(delay / 60000)}분 후`);
  };
  scheduleTokenRefresh();

  // --- 2) 세션 keepalive: 쿠키 재로딩 + /users/me 터치 ---
  const keepalive = setInterval(async () => {
    if (stopped) return;
    try {
      client.reloadCookies();               // Chrome 쿠키 강제 재로딩(최신 세션)
      const r = await client.checkLogin();
      if (r.loggedIn) log('DEBUG', `keepalive OK — ${r.user.name}`);
      else log('ERROR', `⚠️ 세션 끊김 감지! Chrome 재로그인 필요. (${r.error}) — 계속 재시도`);
    } catch (e) { log('WARN', `keepalive 오류: ${e.message}`); }
  }, keepaliveMs);
  timers.push({ [Symbol.for('interval')]: keepalive });
  const intervals = [keepalive];

  // --- 3) 하트비트 ---
  const heartbeat = setInterval(async () => {
    if (stopped) return;
    try {
      const c = await client.getCounts();
      log('INFO', `💓 살아있음 — 안읽음 ${c.unread}건`);
    } catch (e) { log('WARN', `하트비트 오류: ${e.message}`); }
  }, heartbeatMs);
  intervals.push(heartbeat);

  // --- 4) 신규 메시지 감시 ---
  const watcher = watchPolling(client, {
    intervalMs: pollMs, status,
    onMessage: async ({ chat, reason }) => {
      log('INFO', `🔔 새 메시지 [${chat.id}] ${chat.name} (${reason}) 안읽음${chat.unread_count}: ${(chat.last_message || '').replace(/\n/g, ' ').slice(0, 60)}`);
      log('INFO', `   ${chat.link}`);
      onMessage?.({ chat, reason });
      if (autoReply) {
        try {
          const r = await client.sendText(chat.id, replyText);
          await client.markRead(chat.id);
          log('INFO', `   ↩︎ 자동응답 발송 (logId=${r?.id}) + 읽음처리`);
        } catch (e) { log('WARN', `   자동응답 실패: ${e.message}`); }
      }
    },
    onError: (e) => log('WARN', `폴링 오류: ${e.message}`),
  });

  log('INFO', '✅ 감시 시작 — 새 메시지를 기다립니다.');

  // --- 종료 처리 ---
  const shutdown = (sig) => {
    if (stopped) return;
    stopped = true;
    log('INFO', `종료 신호(${sig}) — 정리 중`);
    clear();
    for (const iv of intervals) clearInterval(iv);
    watcher.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await watcher.done; // 무한 대기
}
