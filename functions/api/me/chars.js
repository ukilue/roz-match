// GET /api/me/chars — 「身份卡」：本 Discord 帳號近 7 天登記過的角色
// 同一角色 ID 若登記多次，只回傳等級最高的那一筆（同等級取最新）；含已退出的登記（仍是你的角色）。
// 回傳依等級高→低、角色 ID 排序：[{ charId, level, job, activity, skills, start, end, server }]
// server＝該角色最近一次登記的伺服器（空字串＝分伺服器前的登記）；前端只列出目前伺服器（與空字串）的身份卡
import { getSession, json, needLogin } from "../_auth.js";
import { taipeiNow, addDays } from "../_party.js";

export async function onRequestGet({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  const tw = taipeiNow();
  const since = addDays(tw.date, -7);
  const { results } = await env.DB
    .prepare(`SELECT charId, level, job, activity, skills, startHM AS start, endHM AS "end", server, ts
              FROM regs WHERE discordId = ? AND date >= ? ORDER BY ts DESC`)
    .bind(user.id, since).all();
  // 同名角色可能在不同伺服器各有一隻：以「伺服器＋角色 ID」區分
  const best = {};
  for (const r of results) {
    r.server = r.server || "";
    const k = r.server + "\u0001" + r.charId, cur = best[k];
    if (!cur || r.level > cur.level || (r.level === cur.level && r.ts > cur.ts)) best[k] = r;
  }
  const list = Object.values(best)
    .sort((a, b) => b.level - a.level || a.charId.localeCompare(b.charId))
    .map(({ ts, ...r }) => ({ ...r, skills: String(r.skills || "").split(",").filter(Boolean) }));
  return json(list);
}
