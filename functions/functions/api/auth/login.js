// GET /api/auth/login — 導向 Discord 授權頁
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const auth = new URL("https://discord.com/oauth2/authorize");
  auth.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("redirect_uri", url.origin + "/api/auth/callback");
  auth.searchParams.set("scope", "identify guilds guilds.join");
  auth.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      "Location": auth.toString(),
      "Set-Cookie": `ro_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}
