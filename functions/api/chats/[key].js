// /api/chats/:key — GET 讀取留言（最近 60 則）、POST 新增留言（需 Discord 登入）
import { getSession, needLogin, needMember } from "../_auth.js";

const KEY = /^[a-z0-9]{1,48}$/i;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export async function onRequestGet({ env, params }) {
  const key = String(params.key || "");
  if (!KEY.test(key)) return json({ error: "key 格式錯誤" }, 400);
  const { results } = await env.DB
    .prepare("SELECT name, text, ts FROM chats WHERE key = ? ORDER BY ts DESC LIMIT 60")
    .bind(key).all();
  return json(results.reverse());
}

export async function onRequestPost({ request, env, params }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();
  const key = String(params.key || "");
  if (!KEY.test(key)) return json({ error: "key 格式錯誤" }, 400);
  let b;
  try { b = await request.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400); }
  const name = String(b.name || "").trim().slice(0, 24);
  const text = String(b.text || "").trim().slice(0, 200);
  if (!name || !text) return json({ error: "留言內容不完整" }, 400);
  await env.DB
    .prepare("INSERT INTO chats (key, name, text, ts) VALUES (?,?,?,?)")
    .bind(key, name, text, Date.now()).run();
  return json({ ok: true });
}
