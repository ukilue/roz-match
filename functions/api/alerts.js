// /api/alerts — 廣播關鍵字通知設定（需登入 Discord＋公會伺服器成員；機器人只能私訊同伺服器的人）
//   GET    → { items:[{ id, server, keyword, enabled }], max }   本人的設定
//   POST   body { server, keyword } → 新增（每人最多 MAX_ALERTS 組）；body { id, enable:true } → 重新啟用（私訊失敗被停用後）
//   DELETE ?id= → 刪除本人的設定
// 符合的喇叭廣播由 roz-match-cron（cron-worker）輪詢 broadcasts 後私訊通知。
import { getSession, json, needLogin, needMember } from "./_auth.js";

export const MAX_ALERTS = 1;          // 每人可設定的組數（要開放更多只改這裡）
const KW_MIN = 2, KW_MAX = 20;

async function auth(request, env) {
  const user = await getSession(request, env);
  if (!user) return { err: needLogin() };
  if (!user.member) return { err: needMember() };
  return { user };
}
const listOf = async (env, id) => {
  const { results } = await env.DB.prepare("SELECT id, server, keyword, enabled FROM keyword_alerts WHERE discordId = ? ORDER BY id ASC").bind(id).all();
  return results.map(r => ({ id: r.id, server: r.server, keyword: r.keyword, enabled: !!r.enabled }));
};

export async function onRequestGet({ request, env }) {
  const { user, err } = await auth(request, env); if (err) return err;
  try { return json({ items: await listOf(env, user.id), max: MAX_ALERTS }); }
  catch (e) { console.log("alerts list failed:", e && e.message); return json({ items: [], max: MAX_ALERTS, error: "通知設定暫時無法讀取" }); }
}

export async function onRequestPost({ request, env }) {
  const { user, err } = await auth(request, env); if (err) return err;
  let b; try { b = await request.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400); }
  // 重新啟用
  if (b.id && b.enable) {
    await env.DB.prepare("UPDATE keyword_alerts SET enabled = 1 WHERE id = ? AND discordId = ?").bind(Number(b.id), user.id).run();
    return json({ ok: true, items: await listOf(env, user.id), max: MAX_ALERTS });
  }
  const server = String(b.server || "").trim().slice(0, 40);
  const keyword = String(b.keyword || "").trim().replace(/\s+/g, " ");
  if (!server) return json({ error: "請選擇伺服器" }, 400);
  if ([...keyword].length < KW_MIN || [...keyword].length > KW_MAX) return json({ error: `關鍵字長度需為 ${KW_MIN}～${KW_MAX} 字` }, 400);
  // 伺服器必須真的存在（broadcasts 內有該伺服器的資料）
  const exists = await env.DB.prepare("SELECT 1 AS ok FROM broadcasts WHERE server = ? LIMIT 1").bind(server).first();
  if (!exists) return json({ error: "找不到這個伺服器" }, 400);
  const cur = await listOf(env, user.id);
  if (cur.length >= MAX_ALERTS) return json({ error: `每人最多設定 ${MAX_ALERTS} 組關鍵字通知，請先刪除原本的設定` }, 400);
  await env.DB.prepare("INSERT INTO keyword_alerts (discordId, server, keyword, enabled, ts) VALUES (?,?,?,1,?)").bind(user.id, server, keyword, Date.now()).run();
  return json({ ok: true, items: await listOf(env, user.id), max: MAX_ALERTS });
}

export async function onRequestDelete({ request, env }) {
  const { user, err } = await auth(request, env); if (err) return err;
  const id = Number(new URL(request.url).searchParams.get("id")) || 0;
  if (!id) return json({ error: "缺少參數" }, 400);
  await env.DB.prepare("DELETE FROM keyword_alerts WHERE id = ? AND discordId = ?").bind(id, user.id).run();
  return json({ ok: true, items: await listOf(env, user.id), max: MAX_ALERTS });
}
