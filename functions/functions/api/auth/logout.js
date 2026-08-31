// POST /api/auth/logout — 清除 Session
import { json } from "../_auth.js";

export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "ro_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  });
}
