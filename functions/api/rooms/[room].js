// POST /api/rooms/:room — 私人房間密碼相關操作（需登入且為伺服器成員）
//   body { pw }                       → 驗證密碼（解鎖明細、顯示加入表單前的第一道檢查）→ 200 { ok:true }
//   body { pw, action: "open" }       → 房主「開放」房間：之後任何人不需密碼即可查看名單並加入 → 200 { ok:true, open:true }
//   body { pw, action: "close" }      → 房主重新「鎖上」房間 → 200 { ok:true, open:false }
// 開放／鎖上都必須是房主（房間最早登記者的 Discord 帳號）且再次輸入正確密碼。
// 密碼錯誤 403；連續錯 5 次鎖 10 分鐘 429。密碼只在伺服器端比對雜湊，前端拿不到任何密碼資料。
import { getSession, json, needLogin, needMember } from "../_auth.js";
import { findRoom, checkRoomPw, roomHostId, ROOM_ID } from "../_room.js";

export async function onRequestPost({ request, env, params }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();
  const room = String(params.room || "");
  if (!ROOM_ID.test(room)) return json({ error: "房間參數錯誤" }, 400);
  let b; try { b = await request.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400); }
  const pw = String(b.pw || "");
  const action = String(b.action || "verify");
  if (!["verify", "open", "close"].includes(action)) return json({ error: "action 參數錯誤" }, 400);
  if (!/^\d{4}$/.test(pw)) return json({ error: "房間密碼須為 4 位數字" }, 400);
  const roomRow = await findRoom(env, room);
  if (!roomRow) return json({ error: "找不到這個私人房間" }, 404);
  if (action !== "verify" && (await roomHostId(env, room)) !== user.id) return json({ error: "只有房主（建立房間的人）可以開放或鎖上房間" }, 403);
  const err = await checkRoomPw(env, user.id, room, roomRow.pwHash, pw);
  if (err) return err;
  if (action === "verify") return json({ ok: true, open: !!roomRow.roomOpen });
  const open = action === "open" ? 1 : 0;
  await env.DB.prepare("UPDATE regs SET roomOpen = ? WHERE room = ?").bind(open, room).run();
  return json({ ok: true, open: !!open });
}
