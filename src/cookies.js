// macOS Chrome 쿠키 저장소에서 kakao 세션 쿠키를 읽어온다 (HttpOnly 포함).
// 네이티브 npm 의존성 없이: /usr/bin/sqlite3 + node:crypto + security(Keychain) 사용.
//
// 원리(macOS Chrome):
//  - 쿠키 DB: ~/Library/Application Support/Google/Chrome/<Profile>/Cookies (SQLite)
//  - 암호화 키: Keychain "Chrome Safe Storage" 비밀번호 → PBKDF2(sha1, salt="saltysalt", 1003, 16B)
//  - encrypted_value: "v10" prefix 후 AES-128-CBC(iv=0x20*16). Chrome 130+ 는 평문 앞 32B(도메인 해시) prepend.
//  - DB는 Chrome 실행 중 잠기므로 임시 복사본으로 읽는다.

import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFileSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';

const SALT = 'saltysalt';
const IV = Buffer.alloc(16, ' ');

function keychainPassword() {
  // Keychain 접근 시 최초 1회 macOS 권한 팝업이 뜰 수 있음(허용 필요).
  const out = execFileSync('/usr/bin/security', [
    'find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome',
  ], { encoding: 'utf8' });
  return out.trim();
}

function deriveKey(password) {
  return pbkdf2Sync(password, SALT, 1003, 16, 'sha1');
}

function decryptValue(encrypted, key) {
  if (!encrypted || encrypted.length === 0) return '';
  const prefix = encrypted.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10') return encrypted.toString('utf8'); // 평문(구버전/미암호화)
  const body = encrypted.subarray(3);
  const decipher = createDecipheriv('aes-128-cbc', key, IV);
  decipher.setAutoPadding(false);
  let dec = Buffer.concat([decipher.update(body), decipher.final()]);
  // PKCS7 언패딩
  const pad = dec[dec.length - 1];
  if (pad > 0 && pad <= 16) dec = dec.subarray(0, dec.length - pad);
  // Chrome 130+: 평문 앞 32바이트가 도메인 SHA256 해시(같은 도메인 쿠키는 동일 prefix).
  // 앞 32바이트에 비출력바이트가 있으면 해시 prefix로 보고 제거.
  if (dec.length >= 32) {
    const first32 = dec.subarray(0, 32);
    const looksHash = first32.some((b) => b < 0x20 || b > 0x7e);
    if (looksHash) dec = dec.subarray(32);
  }
  return dec.toString('utf8');
}

export function chromeProfilesDir() {
  return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

// kakao 쿠키가 들어있는 프로필을 자동 탐색해서 쿠키 목록 반환.
// profileHint 로 특정 프로필("Default","Profile 1"...) 지정 가능.
export function loadKakaoCookies({ profileHint = null } = {}) {
  const base = chromeProfilesDir();
  if (!existsSync(base)) throw new Error(`Chrome 프로필 폴더 없음: ${base}`);

  let profiles;
  if (profileHint) profiles = [profileHint];
  else {
    profiles = readdirSync(base).filter((d) => {
      if (d !== 'Default' && !d.startsWith('Profile ')) return false;
      return existsSync(join(base, d, 'Cookies'));
    });
    if (!profiles.includes('Default') && existsSync(join(base, 'Default', 'Cookies'))) {
      profiles.unshift('Default');
    }
  }

  const key = deriveKey(keychainPassword());
  const tmpDir = mkdtempSync(join(tmpdir(), 'kbc-')); // 사용자 전용 0700 임시 디렉터리
  const tmp = join(tmpDir, 'Cookies.sqlite');
  const SQL =
    "SELECT host_key AS host, name, hex(encrypted_value) AS hv, path, is_secure AS secure FROM cookies WHERE host_key LIKE '%kakao.com%';";
  let best = null;

  for (const prof of profiles) {
    const dbPath = join(base, prof, 'Cookies');
    if (!existsSync(dbPath)) continue;
    try {
      copyFileSync(dbPath, tmp);
      const raw = execFileSync('/usr/bin/sqlite3', ['-json', tmp, SQL], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const rows = raw.trim() ? JSON.parse(raw) : [];
      const cookies = [];
      for (const r of rows) {
        let value = '';
        try { value = decryptValue(Buffer.from(r.hv, 'hex'), key); } catch { /* skip */ }
        if (value) cookies.push({ host: r.host, name: r.name, value, path: r.path || '/', secure: r.secure === 1 });
      }
      // 로그인 강도 스코어: _kawlt(완전로그인) 최우선.
      const names = new Set(cookies.map((c) => c.name));
      let score = 0;
      if (names.has('_kawlt') && names.has('_kawltea')) score = 3;
      else if (names.has('_kawlt')) score = 2;
      else if (names.has('_kadu') || names.has('_kau')) score = 1;
      const entry = { profile: prof, cookies, score };
      if (profileHint) { best = entry; break; }             // 지정 프로필이면 그대로
      if (!best || score > best.score) best = entry;
      if (score >= 3) break;                                 // 완전 로그인 찾으면 종료
    } catch { /* 다음 프로필 */ }
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  if (!best || best.cookies.length === 0) {
    throw new Error('kakao 쿠키를 찾지 못했습니다. Chrome에서 business.kakao.com 로그인 상태인지 확인하세요.');
  }
  return best; // { profile, cookies:[{host,name,value,path,secure}], score }
}

// 특정 요청 host 에 대한 Cookie 헤더 문자열을 만든다(도메인 suffix 매칭).
export function cookieHeaderFor(cookies, host) {
  const picked = new Map();
  for (const c of cookies) {
    const dom = c.host.startsWith('.') ? c.host.slice(1) : c.host;
    if (host === dom || host.endsWith('.' + dom)) {
      // Cookie 헤더는 ByteString(<=255) 만 허용 — 비출력/비ASCII 값은 제외(복호화 실패분 방어).
      if (/^[\x20-\x7e]*$/.test(c.value)) picked.set(c.name, c.value);
    }
  }
  return [...picked.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
