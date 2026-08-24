// 카카오 비즈니스 채팅 REST 클라이언트.
// 인증: business.kakao.com/api/* 는 쿠키만, crux-bizgateway 는 Bearer(login/dsp 로 발급).
import { loadKakaoCookies, cookieHeaderFor } from './cookies.js';

const BIZ = 'https://business.kakao.com';
const CRUX = 'https://crux-bizgateway.kakao.com';
const ROCKET_VER = '19';

export class KakaoBizChatClient {
  /**
   * @param {object} opts
   * @param {string} opts.profileId  예: "_XXXXX"
   * @param {string} [opts.cookieHeader]  고정 Cookie 헤더(수동 export). 미지정 시 Chrome 쿠키 자동 로드.
   * @param {string} [opts.profileHint]   Chrome 프로필 이름("Default","Profile 1"...)
   * @param {number} [opts.cookieTtlMs]   쿠키 재로딩 주기(기본 60s) — "무한 로그인"용
   * @param {(host:string)=>string} [opts.cookieProvider]  Cookie 헤더 공급 함수(예: Playwright storageState). 지정 시 최우선.
   */
  constructor({ profileId, cookieHeader = null, profileHint = null, cookieTtlMs = 60_000, cookieProvider = null }) {
    if (!profileId) throw new Error('profileId 필수 (예: "_XXXXX")');
    this.profileId = profileId;
    this.profileHint = profileHint;
    this.cookieTtlMs = cookieTtlMs;
    this._staticCookie = cookieHeader;
    this._cookieProvider = cookieProvider;
    this._cookieCache = null; // { at, cookies, profile }
    this._token = null;       // { accessToken, exp }
  }

  // --- 쿠키 ---
  _cookies() {
    if (this._staticCookie) return null; // 고정 모드
    const now = Date.now();
    if (!this._cookieCache || now - this._cookieCache.at > this.cookieTtlMs) {
      const { profile, cookies } = loadKakaoCookies({ profileHint: this.profileHint });
      this._cookieCache = { at: now, cookies, profile };
    }
    return this._cookieCache.cookies;
  }

  _cookieHeader(host) {
    if (this._cookieProvider) return this._cookieProvider(host);
    if (this._staticCookie) return this._staticCookie;
    return cookieHeaderFor(this._cookies(), host);
  }

  get chromeProfile() {
    if (this._cookieProvider) return this._cookieProvider.label ?? '(provider)';
    return this._cookieCache?.profile ?? '(static)';
  }

  // 쿠키 즉시 재로딩(데몬 keepalive용). provider면 provider.reload, Chrome이면 캐시 무효화. static은 no-op.
  reloadCookies() {
    if (this._cookieProvider) { this._cookieProvider.reload?.(); return; }
    if (this._staticCookie) return;
    this._cookieCache = null;
    this._cookies();
  }

  // --- 저수준 요청 ---
  async _req(url, { method = 'GET', headers = {}, body, rocket = true, bearer = false, raw = false } = {}) {
    const host = new URL(url).host;
    const h = {
      Accept: 'application/json',
      Referer: `${BIZ}/${this.profileId}/chats`,
      'Cookie': this._cookieHeader(host),
      ...headers,
    };
    if (rocket) h['X-Kakao-RocketApiVersion'] = ROCKET_VER;
    if (bearer) h['Authorization'] = `Bearer ${await this.getToken()}`;
    const res = await fetch(url, { method, headers: h, body, redirect: 'manual' });
    if (raw) return res;
    if (res.status === 204) return null;
    if (res.status === 401 || res.status === 302 || res.status === 0) {
      throw new AuthError(`인증 실패(${res.status}) — 세션 만료 가능. ${url}`);
    }
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) throw new ApiError(`HTTP ${res.status} ${url}`, res.status, json);
    return json;
  }

  // --- 인증/세션 ---
  async checkLogin() {
    try {
      const me = await this._req(`${BIZ}/api/users/me`);
      return { loggedIn: true, user: me };
    } catch (e) {
      if (e instanceof AuthError) return { loggedIn: false, error: e.message };
      throw e;
    }
  }

  async getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._token && this._token.exp - now > 60) return this._token.accessToken;
    return this.refreshToken();
  }

  // 무한 로그인의 핵심: 쿠키로 새 1시간짜리 JWT 발급.
  async refreshToken() {
    const host = new URL(CRUX).host;
    const res = await fetch(`${CRUX}/auth/login/dsp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: `${BIZ}/`, Cookie: this._cookieHeader(host) },
      body: '{}', redirect: 'manual',
    });
    if (!res.ok) throw new AuthError(`토큰 리프레시 실패(${res.status})`);
    const { accessToken } = await res.json();
    const exp = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).exp;
    this._token = { accessToken, exp };
    return accessToken;
  }

  // --- 채팅방 ---
  async getCounts() {
    return this._req(`${BIZ}/api/profiles/${this.profileId}/counts`);
  }

  /** 채팅방 리스트. status: "progress"|"done" */
  async listChats({ status = 'progress', keyword = '', labels = [], size = 100, isBlocked = false } = {}) {
    const url = `${BIZ}/api/profiles/${this.profileId}/chats/search?size=${size}`;
    const data = await this._req(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_blocked: isBlocked, status, keyword, labels }),
    });
    return (data?.items ?? []).map((c) => this._decorate(c));
  }

  async getUnreadChats(opts = {}) {
    const list = await this.listChats(opts);
    return list.filter((c) => !c.is_read);
  }

  _decorate(c) {
    return { ...c, link: `${BIZ}/${this.profileId}/chats/${c.id}` };
  }

  async getChat(chatId) {
    const c = await this._req(`${BIZ}/api/profiles/${this.profileId}/chats/${chatId}?isEnterChatRoom=true`);
    return this._decorate(c);
  }

  /** 대화내역. direction: "backward"(과거)|"forward"(이후), since=기준 logId */
  async getChatlogs(chatId, { since = null, direction = null } = {}) {
    let url = `${BIZ}/api/profiles/${this.profileId}/chats/${chatId}/chatlogs`;
    const qs = [];
    if (since) qs.push(`since=${since}`);
    if (direction) qs.push(`direction=${direction}`);
    if (qs.length) url += `?${qs.join('&')}`;
    const data = await this._req(url);
    const items = (data?.items ?? []).map((m) => this._decorateLog(m));
    return { items, has_prev: !!data?.has_prev, has_next: !!data?.has_next };
  }

  _decorateLog(m) {
    const fromUs = m.author_id === this.profileId || m.author?.user_type === 1;
    return {
      ...m,
      from: fromUs ? 'us' : 'customer',
      isSystem: m.type === 71,
      links: m.attachment?.urls ?? [],
    };
  }

  /** 읽음 처리. lastSeenLogId 미지정 시 해당 방 최신 로그로 자동. */
  async markRead(chatId, lastSeenLogId = null) {
    if (!lastSeenLogId) {
      const chat = await this.getChat(chatId);
      lastSeenLogId = chat.last_log_id;
    }
    await this._req(
      `${BIZ}/api/profiles/${this.profileId}/chats/${chatId}/chatlogs/mark?lastSeenLogId=${lastSeenLogId}`,
      { raw: false }
    );
    return { chatId, lastSeenLogId };
  }

  /** ⚠️ 실제 고객에게 텍스트 발송. */
  async sendText(chatId, text) {
    if (!text || !text.trim()) throw new Error('빈 메시지');
    const fd = new FormData();
    fd.append('text', text);
    const url = `${BIZ}/api/profiles/${this.profileId}/chats/${chatId}/chatlogs`;
    // FormData 사용 시 Content-Type(boundary)은 fetch가 자동 설정.
    return this._req(url, { method: 'POST', body: fd });
  }

  async deleteChatlog(chatId, logId) {
    return this._req(`${BIZ}/api/profiles/${this.profileId}/chats/${chatId}/chatlogs/${logId}`, { method: 'DELETE' });
  }

  async getConsult() {
    return this._req(`${BIZ}/api/profiles/${this.profileId}/chats/consult`);
  }
}

export class ApiError extends Error {
  constructor(msg, status, body) { super(msg); this.name = 'ApiError'; this.status = status; this.body = body; }
}
export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; }
}
