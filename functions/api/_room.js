// functions/api/_room.js — 私人房間密碼共用工具（底線開頭的檔案不會成為路由）
//
// 設計：
// - 房間密碼為 4 位數字，只存 SHA-256("房間ID:密碼") 雜湊在 regs.pwHash（房間內每筆登記同一份），
//   查詢 API 絕不回傳 pwHash，前端／F12 拿不到任何可反推密碼的資料。
// - 4 位數只有 10000 種組合，因此另以 pw_attempts 表限制：同一 Discord 帳號對同一房間
//   連續錯 5 次即鎖 10 分鐘（表不存在時只是不限制，功能不受影響）。
import { json } from "./_auth.js";

export const ROOM_ID = /^[a-z0-9-]{8,40}$/i;   // crypto.randomUUID() 格式
export const PW = /^\d{4}$/;
const MAX_TRIES = 5, LOCK_MS = 10 * 60 * 1000;

const enc = new TextEncoder();
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export const roomPwHash = (room, pw) => sha256hex(room + ":" + pw);

// 找出房間的密碼雜湊（房間內任一筆登記皆可，含已退出者）；找不到 → null
export async function findRoom(env, room) {
  if (!ROOM_ID.test(room)) return null;
  return env.DB.prepare("SELECT pwHash, date, activity, startHM AS start, endHM AS \"end\" FROM regs WHERE room = ? AND pwHash != '' LIMIT 1").bind(room).first();
}

// 驗證密碼；成功回傳 null，失敗回傳可直接送出的 Response（403 密碼錯誤／429 嘗試過多）
export async function checkRoomPw(env, discordId, room, pwHash, pw) {
  const key = room + "|" + discordId, now = Date.now();
  let row = null;
  try { row = await env.DB.prepare("SELECT n, ts FROM pw_attempts WHERE key = ?").bind(key).first(); } catch {}
  if (row && row.n >= MAX_TRIES && now - row.ts < LOCK_MS) {
    return json({ error: `房間密碼錯誤次數過多，請 ${Math.ceil((LOCK_MS - (now - row.ts)) / 60000)} 分鐘後再試` }, 429);
  }
  const ok = PW.test(pw) && (await roomPwHash(room, pw)) === pwHash;
  if (!ok) {
    const n = (row && now - row.ts < LOCK_MS) ? row.n + 1 : 1;
    try {
      await env.DB.prepare("INSERT INTO pw_attempts (key, n, ts) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET n = excluded.n, ts = excluded.ts")
        .bind(key, n, now).run();
    } catch {}
    return json({ error: n >= MAX_TRIES ? "房間密碼錯誤，已連續錯 5 次，請 10 分鐘後再試" : `房間密碼錯誤（還可嘗試 ${MAX_TRIES - n} 次）` }, 403);
  }
  try { await env.DB.prepare("DELETE FROM pw_attempts WHERE key = ?").bind(key).run(); } catch {}
  return null;
}
