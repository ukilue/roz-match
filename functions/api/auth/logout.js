// POST /api/auth/logout — 登出：刪除伺服器端 Session（立即在所有裝置失效）
import { destroySession } from "../_auth.js";

export async function onRequestPost({ request, env }) {
  await destroySession(request, env);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "ro_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  });
}
