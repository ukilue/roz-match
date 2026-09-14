// DELETE /api/regs/:uid — 退出揪團（軟刪除）
// 需登入 Discord，且這筆登記必須是本人帳號建立的。
// 採軟刪除（removed=1）而非真刪：退出者仍作為揪團編號的錨點，
// 創團者退出後編號、留言板都不會變動；7 天後由排程器實際清除。
import { getSession, json, needLogin, needMember } from "../_auth.js";

export async function onRequestDelete({ request, env, params }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();

  const uid = String(params.uid || "");
  if (!uid) return json({ error: "缺少參數" }, 400);

  const row = await env.DB.prepare("SELECT discordId, removed FROM regs WHERE uid = ?").bind(uid).first();
  if (!row) return json({ error: "找不到這筆登記" }, 404);
  if (row.discordId !== user.id) return json({ error: "只能退出自己 Discord 帳號登記的揪團" }, 403);

  await env.DB.prepare("UPDATE regs SET removed = 1 WHERE uid = ?").bind(uid).run();
  return json({ deleted: true });
}
