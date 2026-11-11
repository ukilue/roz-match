// /api/binds — 角色綁定（需登入 Discord）
//   GET    → { items:[{ id, server, charName }], max }   本人的綁定
//   POST   body { server, charName } → 新增（每帳號最多 MAX_BINDS 個；同伺服器同名只能被一個帳號綁定）
//   DELETE ?id= → 刪除本人的綁定
// 綁定後，該角色在廣播／交易頁的發話者旁會出現 Discord 私訊按鈕（對照表見 binds/map.js）。
import { getSession, json, needLogin } from "./_auth.js";

export const MAX_BINDS = 10;
const NAME_MAX = 24;

const listOf = async (env, id) => {
  const { results } = await env.DB.prepare("SELECT id, server, charName FROM char_binds WHERE discordId = ? ORDER BY server ASC, id ASC").bind(id).all();
  return results;
};

export async function onRequestGet({ request, env }) {
  const user = await getSession(request, env); if (!user) return needLogin();
  try { return json({ items: await listOf(env, user.id), max: MAX_BINDS }); }
  catch (e) { console.log("binds list failed:", e && e.message); return json({ items: [], max: MAX_BINDS, error: "綁定資料暫時無法讀取" }); }
}

export async function onRequestPost({ request, env }) {
  const user = await getSession(request, env); if (!user) return needLogin();
  let b; try { b = await request.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400); }
  const server = String(b.server || "").trim().slice(0, 40);
  const charName = String(b.charName || "").trim();
  if (!server) return json({ error: "請選擇伺服器" }, 400);
  if (!charName || [...charName].length > NAME_MAX) return json({ error: `角色名稱需為 1～${NAME_MAX} 字` }, 400);
  const exists = await env.DB.prepare("SELECT 1 AS ok FROM broadcasts WHERE server = ? LIMIT 1").bind(server).first();
  if (!exists) return json({ error: "找不到這個伺服器" }, 400);
  const cur = await listOf(env, user.id);
  if (cur.some(x => x.server === server && x.charName === charName)) return json({ error: "這個角色你已經綁定過了" }, 400);
  if (cur.length >= MAX_BINDS) return json({ error: `每個帳號最多綁定 ${MAX_BINDS} 個角色` }, 400);
  const taken = await env.DB.prepare("SELECT discordId FROM char_binds WHERE server = ? AND charName = ?").bind(server, charName).first();
  if (taken) return json({ error: "這個角色名稱已被其他帳號綁定；若為冒名，請聯絡管理員處理" }, 409);
  try {
    await env.DB.prepare("INSERT INTO char_binds (discordId, server, charName, ts) VALUES (?,?,?,?)").bind(user.id, server, charName, Date.now()).run();
  } catch (e) { return json({ error: "這個角色名稱已被綁定" }, 409); }
  return json({ ok: true, items: await listOf(env, user.id), max: MAX_BINDS });
}

export async function onRequestDelete({ request, env }) {
  const user = await getSession(request, env); if (!user) return needLogin();
  const id = Number(new URL(request.url).searchParams.get("id")) || 0;
  if (!id) return json({ error: "缺少參數" }, 400);
  await env.DB.prepare("DELETE FROM char_binds WHERE id = ? AND discordId = ?").bind(id, user.id).run();
  return json({ ok: true, items: await listOf(env, user.id), max: MAX_BINDS });
}
