// DELETE /api/regs/:uid — 退出揪團
// 需登入 Discord，且這筆登記必須是本人帳號建立的，
// 從根本杜絕惡意幫別人退團；也不再受限於「同一台裝置」。
import { getSession, json, needLogin, needMember } from "../_auth.js";

export async function onRequestDelete({ request, env, params }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();

  const uid = String(params.uid || "");
  if (!uid) return json({ error: "缺少參數" }, 400);

  const row = await env.DB.prepare("SELECT discordId FROM regs WHERE uid = ?").bind(uid).first();
  if (!row) return json({ error: "找不到這筆登記" }, 404);
  if (row.discordId !== user.id) return json({ error: "只能退出自己 Discord 帳號登記的揪團" }, 403);

  await env.DB.prepare("DELETE FROM regs WHERE uid = ?").bind(uid).run();
  return json({ deleted: true });
}
