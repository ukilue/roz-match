// GET /api/auth/me — 回傳目前登入者（未登入回 401）
import { getSession, json } from "../_auth.js";
import { mvpAllowed, MVP_PUBLIC } from "../_mvp.js";

export async function onRequestGet({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return json({ error: "未登入" }, 401);
  // mvp：此帳號是否可看 MVP 資訊（限時公開期一律 true，否則查 mvp_viewers；/api/mvp 會再驗一次）
  return json({ id: user.id, name: user.name, member: !!user.member, mvp: await mvpAllowed(env, user.id), mvpPublic: MVP_PUBLIC });
}
