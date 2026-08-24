// Playwright 기반 인증 프로바이더 (크로스플랫폼, 자체 브라우저 로그인).
//  - loginInteractive: 브라우저를 띄워 사용자가 직접 로그인(PW·2FA·캡차 처리) → storageState 저장
//  - makeStateProvider: storageState 파일에서 Cookie 헤더를 만드는 provider(client 주입용)
//  - keepAlive: storageState로 브라우저 세션을 유지하며 주기적으로 사이트를 터치 → 쿠키 안 풀리게
//
// playwright 는 optional dependency. 미설치 시 안내 후 종료.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOGIN_URL = 'https://accounts.kakao.com/login/?continue=https://business.kakao.com/dashboard';
const CHECK_URL = 'https://business.kakao.com/api/users/me';

async function loadPlaywright() {
  try {
    const pw = await import('playwright');
    return pw.chromium;
  } catch {
    throw new Error(
      'playwright 가 설치되지 않았습니다. 이 인증 방식을 쓰려면:\n' +
      '  npm i playwright && npx playwright install chromium'
    );
  }
}

// storageState({cookies:[{name,value,domain,path,...}]}) → 특정 host용 Cookie 헤더
export function cookieHeaderFromState(state, host) {
  const picked = new Map();
  for (const c of state.cookies || []) {
    const dom = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    if (host === dom || host.endsWith('.' + dom)) {
      if (/^[\x20-\x7e]*$/.test(c.value)) picked.set(c.name, c.value);
    }
  }
  return [...picked.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// client 에 주입할 cookieProvider 생성. 파일 변경 시 자동 재로딩.
export function makeStateProvider(statePath) {
  let cache = null; let mtime = 0;
  const read = () => {
    const stat = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null;
    if (!stat) throw new Error(`storageState 없음: ${statePath} — 먼저 'kbc login' 실행`);
    cache = JSON.parse(stat);
  };
  const provider = (host) => {
    if (!cache) read();
    return cookieHeaderFromState(cache, host);
  };
  provider.reload = () => { cache = null; read(); };
  provider.label = `playwright:${statePath}`;
  return provider;
}

// 대화형 로그인: 브라우저를 띄워 사용자가 직접 로그인 → 성공 감지 시 storageState 저장.
export async function loginInteractive({ statePath, headless = false, timeoutMs = 300_000 } = {}) {
  const chromium = await loadPlaywright();
  mkdirSync(dirname(statePath), { recursive: true });
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext(existsSync(statePath) ? { storageState: statePath } : {});
  const page = await ctx.newPage();
  console.error('[login] 브라우저에서 카카오 계정으로 로그인하세요(2FA·캡차 포함). 완료를 자동 감지합니다...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    try {
      const res = await ctx.request.get(CHECK_URL, { failOnStatusCode: false });
      if (res.status() === 200) { ok = true; break; }
    } catch { /* 아직 로그인 전 */ }
  }
  if (!ok) { await browser.close(); throw new Error('로그인 시간 초과 — 다시 시도하세요.'); }

  await ctx.storageState({ path: statePath });
  await browser.close();
  console.error(`[login] ✅ 로그인 성공 — 세션 저장: ${statePath}`);
  return statePath;
}

// 세션 유지 루프: storageState로 브라우저를 열고 주기적으로 사이트를 터치 → 쿠키 자동 갱신 + 재저장.
export async function keepAlive({ statePath, intervalMs = 20 * 60_000, headless = true, onError = null } = {}) {
  const chromium = await loadPlaywright();
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ storageState: statePath });
  const page = await ctx.newPage();
  let stopped = false;
  const tick = async () => {
    try {
      await page.goto('https://business.kakao.com/dashboard', { waitUntil: 'domcontentloaded' });
      const res = await ctx.request.get(CHECK_URL, { failOnStatusCode: false });
      if (res.status() === 200) await ctx.storageState({ path: statePath }); // 갱신된 쿠키 재저장
      else onError?.(new Error(`keepAlive 세션 확인 실패(${res.status()})`));
    } catch (e) { onError?.(e); }
  };
  await tick();
  const iv = setInterval(() => { if (!stopped) tick(); }, intervalMs);
  return {
    stop: async () => { stopped = true; clearInterval(iv); await browser.close().catch(() => {}); },
  };
}
