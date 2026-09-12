// POST /api/rooms/:room — 私人房間密碼驗證（解鎖明細、顯示加入表單前的第一道檢查）
// body { pw: "1234" } → 200 { ok:true }；密碼錯誤 403；連續錯 5 次鎖 10 分鐘 429。
// 需登入且為伺服器成員。密碼只在伺服器端比對雜湊，前端拿不到任何密碼資料；
// 之後真正加入（POST /api/regs 帶 room+pw）時伺服器會再驗證一次。
import { getSession, json, needLogin, needMember } from "../_auth.js";
import { findRoom, checkRoomPw, ROOM_ID } from "../_room.js";

export async function onRequestPost({ request, env, params }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();
  const room = String(params.room || "");
  if (!ROOM_ID.test(room)) return json({ error: "房間參數錯誤" }, 400);
  let b; try { b = await request.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400); }
  const pw = String(b.pw || "");
  if (!/^\d{4}$/.test(pw)) return json({ error: "房間密碼須為 4 位數字" }, 400);
  const roomRow = await findRoom(env, room);
  if (!roomRow) return json({ error: "找不到這個私人房間" }, 404);
  const err = await checkRoomPw(env, user.id, room, roomRow.pwHash, pw);
  if (err) return err;
  return json({ ok: true });
}
