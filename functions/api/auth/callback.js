// GET /api/auth/callback — Discord 授權完成後的回呼
// 1. 驗證 state 防 CSRF
// 2. 用 code + Client Secret（僅存於後端環境變數）換 access token
// 3. 取得使用者資料，並查其加入的伺服器清單
// 4. 必須是 DISCORD_GUILD_ID 指定伺服器的成員，才發放 Session Cookie
import { makeSession, sessionCookie } from "../_auth.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const fail = reason => new Response(null, { status: 302, headers: { Location: "/?auth=" + reason } });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cs = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)ro_state=([^;]+)/);
  if (!code || !state || !cs || cs[1] !== state) return fail("state");

  // 換取 access token
  const tr = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: url.origin + "/api/auth/callback"
    })
  });
  if (!tr.ok) return fail("token");
  const tok = await tr.json();
  const h = { Authorization: `Bearer ${tok.access_token}` };

  // 使用者資料
  const ur = await fetch("https://discord.com/api/users/@me", { headers: h });
  if (!ur.ok) return fail("user");
  const user = await ur.json();

  // 驗證是否為指定伺服器成員
  const gr = await fetch("https://discord.com/api/users/@me/guilds", { headers: h });
  if (!gr.ok) return fail("guilds");
  const guilds = await gr.json();
  if (!Array.isArray(guilds) || !guilds.some(g => g.id === env.DISCORD_GUILD_ID)) return fail("notmember");

  const sess = await makeSession(env, { id: user.id, name: user.global_name || user.username });
  const headers = new Headers({ Location: "/?auth=ok" });
  headers.append("Set-Cookie", sessionCookie(sess, 7 * 86400));
  headers.append("Set-Cookie", "ro_state=; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
