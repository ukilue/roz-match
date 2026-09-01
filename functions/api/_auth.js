// functions/api/_auth.js — 共用認證工具（底線開頭的檔案不會成為路由）
//
// 伺服器端 Session 設計：
// - Cookie 只存 64 字元的隨機亂數（sid），不含任何身分資料 → 沒有可竄改的內容，
//   改動任何一個字元都只會變成「查無此 Session」。
// - 身分資料（Discord ID、暱稱、成員資格、效期）全部存在 D1 的 sessions 表。
// - 資料庫存的是 sid 的 SHA-256 雜湊：就算資料庫內容外洩，也無法反推出可用的 Cookie。
// - 登出＝刪除資料列，Session 立即在所有裝置失效（可撤銷）。

const enc = new TextEncoder();

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomSid() {
  const a = new Uint8Array(32);                       // 256 bits 亂數
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}
function readSid(request) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)ro_sess=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

export async function createSession(env, user, ttlMs = 7 * 864e5) {
  const sid = randomSid();
  const now = Date.now();
  await env.DB.prepare("DELETE FROM sessions WHERE exp < ?").bind(now).run();   // 順手清除過期 Session
  await env.DB
    .prepare("INSERT INTO sessions (sidHash, discordId, name, member, exp) VALUES (?,?,?,?,?)")
    .bind(await sha256hex(sid), user.id, user.name, user.member ? 1 : 0, now + ttlMs)
    .run();
  return sid;
}

export async function getSession(request, env) {
  const sid = readSid(request);
  if (!sid) return null;
  const row = await env.DB
    .prepare("SELECT discordId, name, member, exp FROM sessions WHERE sidHash = ?")
    .bind(await sha256hex(sid)).first();
  if (!row || Date.now() > row.exp) return null;
  return { id: row.discordId, name: row.name, member: !!row.member };
}

export async function destroySession(request, env) {
  const sid = readSid(request);
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE sidHash = ?").bind(await sha256hex(sid)).run();
}

export const sessionCookie = (val, maxAge) =>
  `ro_sess=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export const needLogin = () => json({ error: "請先登入 Discord" }, 401);
export const needMember = () => json({ error: "請先加入懿岐來揪團 Discord 伺服器" }, 403);
