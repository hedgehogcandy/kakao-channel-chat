#!/usr/bin/env node
// 카카오 채널(비즈니스 채팅) MCP 서버 — stdio.
// 로그인된 Chrome 세션을 재사용해 채널 채팅을 MCP 툴로 노출한다.
// 설정: 환경변수(또는 .env) KBC_PROFILE_ID 필수. KBC_CHROME_PROFILE/KBC_COOKIE 선택.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { KakaoBizChatClient } from './client.js';

try { process.loadEnvFile(); } catch { /* .env 없으면 무시 */ }

const PROFILE_ID = process.env.KBC_PROFILE_ID;
if (!PROFILE_ID) {
  console.error('[kakao-channel-mcp] KBC_PROFILE_ID 환경변수가 필요합니다.');
  process.exit(1);
}
const ALLOW_SEND = process.env.KBC_MCP_ALLOW_SEND === '1'; // 발송 툴 노출 여부(기본 off)

let cookieProvider = null;
if (process.env.KBC_AUTH === 'playwright') {
  const { makeStateProvider } = await import('./auth-playwright.js');
  cookieProvider = makeStateProvider(process.env.KBC_PW_STATE || '.kbc-auth/state.json');
}
const client = new KakaoBizChatClient({
  profileId: PROFILE_ID,
  cookieProvider,
  cookieHeader: process.env.KBC_COOKIE || null,
  profileHint: process.env.KBC_CHROME_PROFILE || null,
});

const TOOLS = [
  {
    name: 'kakao_login_status',
    description: '카카오 채널 로그인 상태를 확인한다(계정 정보 반환).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => client.checkLogin(),
  },
  {
    name: 'kakao_unread_count',
    description: '안읽은 채팅 개수를 반환한다.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => client.getCounts(),
  },
  {
    name: 'kakao_list_chats',
    description: '채팅방 리스트를 반환한다. 각 방은 id, name, last_message, is_read, unread_count, is_replied, link 포함.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['progress', 'done'], description: '진행중/완료 (기본 progress)' },
        unreadOnly: { type: 'boolean', description: 'true면 안읽은 방만' },
        keyword: { type: 'string', description: '검색어' },
      },
    },
    handler: async ({ status = 'progress', unreadOnly = false, keyword = '' }) => {
      const list = await client.listChats({ status, keyword });
      const filtered = unreadOnly ? list.filter((c) => !c.is_read) : list;
      return filtered.map((c) => ({
        id: c.id, name: c.name, last_message: c.last_message,
        is_read: c.is_read, unread_count: c.unread_count, is_replied: c.is_replied,
        is_done: c.is_done, updated_at: c.updated_at, last_log_id: c.last_log_id, link: c.link,
      }));
    },
  },
  {
    name: 'kakao_get_chat',
    description: '특정 채팅방 상세 정보를 반환한다.',
    inputSchema: { type: 'object', properties: { chatId: { type: 'string' } }, required: ['chatId'] },
    handler: async ({ chatId }) => client.getChat(chatId),
  },
  {
    name: 'kakao_get_messages',
    description: '채팅방 대화내역을 반환한다. 각 메시지의 from 필드로 us(우리)/customer(고객) 구분, links 배열에 링크.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        since: { type: 'string', description: '기준 logId(페이지네이션)' },
        direction: { type: 'string', enum: ['backward', 'forward'], description: 'backward=과거' },
      },
      required: ['chatId'],
    },
    handler: async ({ chatId, since = null, direction = null }) => {
      const { items } = await client.getChatlogs(chatId, { since, direction });
      return items.map((m) => ({
        id: m.id, from: m.from, message: m.message, type: m.type,
        isSystem: m.isSystem, send_at: m.send_at, links: m.links,
      }));
    },
  },
  {
    name: 'kakao_mark_read',
    description: '채팅방을 읽음 처리한다.',
    inputSchema: {
      type: 'object',
      properties: { chatId: { type: 'string' }, lastSeenLogId: { type: 'string' } },
      required: ['chatId'],
    },
    handler: async ({ chatId, lastSeenLogId = null }) => client.markRead(chatId, lastSeenLogId),
  },
];

const SEND_TOOL = {
  name: 'kakao_send_message',
  description: '⚠️ 채팅방에 텍스트 메시지를 실제로 발송한다(고객에게 즉시 전달). 발송 전 사용자 확인 권장.',
  inputSchema: {
    type: 'object',
    properties: { chatId: { type: 'string' }, text: { type: 'string' } },
    required: ['chatId', 'text'],
  },
  handler: async ({ chatId, text }) => client.sendText(chatId, text),
};

const active = ALLOW_SEND ? [...TOOLS, SEND_TOOL] : TOOLS;
const byName = Object.fromEntries(active.map((t) => [t.name, t]));

const server = new Server(
  { name: 'kakao-channel-chat', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: active.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = byName[req.params.name];
  if (!tool) return { isError: true, content: [{ type: 'text', text: `알 수 없는 툴: ${req.params.name}` }] };
  try {
    const result = await tool.handler(req.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `오류: ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[kakao-channel-mcp] 시작됨 — 프로필=${PROFILE_ID}, 발송툴=${ALLOW_SEND ? 'ON' : 'OFF'}`);
