// functions/api/_auth.js — 共用認證工具（底線開頭的檔案不會成為路由）
// Session 採 HMAC-SHA256 簽章的 Cookie，密鑰存於 Cloudflare 環境變數，前端拿不到。

const enc = new TextEncoder();

const b64u = buf =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const strToB64u = s =>
  btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uToStr = s => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
};

async function sign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function makeSession(env, user) {
  const payload = strToB64u(JSON.stringify({ ...user, exp: Date.now() + 7 * 864e5 })); // 7 天
  return payload + "." + (await sign(env.SESSION_SECRET, payload));
}

export async function getSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)ro_sess=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  if ((await sign(env.SESSION_SECRET, payload)) !== sig) return null;
  let u;
  try { u = JSON.parse(b64uToStr(payload)); } catch { return null; }
  if (!u.exp || Date.now() > u.exp) return null;
  return u; // { id, name, exp }
}

export const sessionCookie = (val, maxAge) =>
  `ro_sess=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export const needLogin = () => json({ error: "請先登入 Discord 並加入公會伺服器" }, 401);
