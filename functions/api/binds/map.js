// GET /api/binds/map?server= — 該伺服器所有綁定的「角色名稱 → Discord ID」對照（需登入；瀏覽器快取 60 秒）
// 前端用來在廣播／交易頁的發話者旁顯示私訊按鈕（https://discord.com/users/<ID>）。
// 只回傳玩家自願綁定的角色；未綁定者的 Discord ID 不會出現在任何 API。
import { getSession, json, needLogin } from "../_auth.js";

export async function onRequestGet({ request, env }) {
  if (!(await getSession(request, env))) return needLogin();
  const server = (new URL(request.url).searchParams.get("server") || "").trim().slice(0, 40);
  try {
    const { results } = await env.DB.prepare("SELECT charName, discordId FROM char_binds WHERE server = ?").bind(server).all();
    const map = {}; results.forEach(r => { map[r.charName] = r.discordId; });
    const res = json({ server, map });
    res.headers.set("Cache-Control", "private, max-age=60");
    return res;
  } catch (e) {
    console.log("binds map failed:", e && e.message);
    return json({ server, map: {} });
  }
}
