// GET /api/auth/me — 回傳目前登入者（未登入回 401）
import { getSession, json } from "../_auth.js";

export async function onRequestGet({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return json({ error: "未登入" }, 401);
  return json({ id: user.id, name: user.name });
}
