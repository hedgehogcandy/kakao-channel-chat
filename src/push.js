// 실시간 알람 캐치: (A) SSE 스트림, (B) 폴링 폴백.
// SSE 는 Node fetch 스트리밍으로 직접 파싱(전역 EventSource 의존 X).

const SSE_URL = 'https://business-proxy.kakao.com/api/public/notification/events';

/**
 * 비즈센터 SSE 알림 스트림 구독.
 * @returns {{stop:()=>void, done:Promise<void>}}
 */
export function watchSSE(client, onEvent, { onError = null } = {}) {
  const ctrl = new AbortController();
  const host = new URL(SSE_URL).host;

  const done = (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch(SSE_URL, {
          headers: {
            Accept: 'text/event-stream',
            Referer: 'https://business.kakao.com/',
            Cookie: client._cookieHeader(host),
          },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const ev = parseSSE(chunk);
            if (ev) onEvent(ev);
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) break;
        onError?.(e);
        await sleep(3000); // 재연결 백오프
      }
    }
  })();

  return { stop: () => ctrl.abort(), done };
}

function parseSSE(chunk) {
  const ev = { event: 'message', data: '', id: null };
  let has = false;
  for (const line of chunk.split('\n')) {
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'data') { ev.data += (ev.data ? '\n' : '') + val; has = true; }
    else if (field === 'event') { ev.event = val; has = true; }
    else if (field === 'id') ev.id = val;
  }
  if (!has) return null;
  try { ev.json = JSON.parse(ev.data); } catch {}
  return ev;
}

/**
 * 폴링 폴백: 채팅방 리스트를 주기적으로 재조회해 새 고객 메시지를 감지.
 * onMessage({chat, prevVersion}) 는 방의 version(=서버 갱신 시각)이 오르고
 * 마지막 메시지가 고객발일 때 호출.
 */
export function watchPolling(client, { intervalMs = 4000, onMessage, onError = null, status = 'progress' } = {}) {
  let stopped = false;
  const versions = new Map(); // chatId -> version
  let seeded = false;

  const done = (async () => {
    // 시드: 최초 상태 기록(초기 폭주 방지)
    try {
      for (const c of await client.listChats({ status })) versions.set(c.id, c.version);
      seeded = true;
    } catch (e) { onError?.(e); }

    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) break;
      try {
        const list = await client.listChats({ status });
        for (const c of list) {
          const prev = versions.get(c.id);
          versions.set(c.id, c.version);
          // 신규 감지: (a) 시드 이후 새로 생긴 방  또는  (b) 기존 방의 version 상승
          const isNew = seeded && prev === undefined;         // 시드 후 등장 = 새 방
          const bumped = prev !== undefined && c.version > prev; // 기존 방 갱신
          if ((isNew || bumped) && !c.is_read) {
            onMessage?.({ chat: c, prevVersion: prev ?? null, reason: isNew ? 'new' : 'bump' });
          }
        }
        if (!seeded) seeded = true; // 시드가 실패했었다면 이번 목록을 베이스라인으로
      } catch (e) { onError?.(e); }
    }
  })();

  return { stop: () => { stopped = true; }, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
