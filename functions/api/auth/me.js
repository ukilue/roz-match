// GET /api/auth/me — 回傳目前登入者（未登入回 401）
import { getSession, json } from "../_auth.js";
import { canViewMvp } from "../_mvp.js";

export async function onRequestGet({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return json({ error: "未登入" }, 401);
  // mvp：此帳號是否在 mvp_viewers 表內（前端據此顯示「MVP 資訊」按鈕；/api/mvp 會再驗一次）
  return json({ id: user.id, name: user.name, member: !!user.member, mvp: await canViewMvp(env, user.id) });
}
