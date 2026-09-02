// /api/chats/:key — 團員留言板
// 安全設計：讀與寫都必須是「該團成員」——伺服器端重算今日分團，
// 驗證請求者的 Discord 帳號在該 chatKey 對應的團內，否則 403。
// 就算從 F12 拿到別團的 chatKey 也讀不到內容。
// 留言署名由伺服器決定（請求者在該團登記的角色 ID），無法冒名。
// GET 支援 ?after=<ts> 增量讀取，前端只需附加新訊息、不必整段重畫。
import { getSession, needLogin, needMember, json } from "../_auth.js";
import { buildParties, taipeiNow } from "../_party.js";

const KEY = /^[a-z0-9]{1,48}$/i;

async function authorize(env, request, key) {
  if (!KEY.test(key)) return { err: json({ error: "key 格式錯誤" }, 400) };
  const user = await getSession(request, env);
  if (!user) return { err: needLogin() };
  if (!user.member) return { err: needMember() };
  const tw = taipeiNow();
  const { results } = await env.DB
    .prepare(`SELECT uid, discordId, charId, level, job, activity, startHM AS start, endHM AS "end", date, bento, role, removed, ts
              FROM regs WHERE date = ?`)
    .bind(tw.date).all();
  const parties = buildParties(results.map(r => ({ ...r, bento: !!r.bento, role: r.role || "", removed: !!r.removed })), tw.date);
  const party = parties.find(p => p.chatKey === key);
  if (!party) return { err: json({ error: "找不到這個揪團的留言板" }, 404) };
  const me = party.members.find(m => m.discordId === user.id);
  if (!me) return { err: json({ error: "只有本團成員能使用留言板" }, 403) };
  return { me };
}

export async function onRequestGet({ request, env, params }) {
  const key = String(params.key || "");
  const auth = await authorize(env, request, key);
  if (auth.err) return auth.err;
  const after = Number(new URL(request.url).searchParams.get("after") || 0);
  if (after > 0) {
    const { results } = await env.DB
      .prepare("SELECT name, text, ts FROM chats WHERE key = ? AND ts > ? ORDER BY ts ASC LIMIT 100")
      .bind(key, after).all();
    return json(results);
  }
  const { results } = await env.DB
    .prepare("SELECT name, text, ts FROM chats WHERE key = ? ORDER BY ts DESC LIMIT 60")
    .bind(key).all();
  return json(results.reverse());
}

export async function onRequestPost({ request, env, params }) {
  const key = String(params.key || "");
  const auth = await authorize(env, request, key);
  if (auth.err) return auth.err;
  let b;
  try { b = await request.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400); }
  const text = String(b.text || "").trim().slice(0, 200);
  if (!text) return json({ error: "留言內容不完整" }, 400);
  await env.DB
    .prepare("INSERT INTO chats (key, name, text, ts) VALUES (?,?,?,?)")
    .bind(key, auth.me.charId, text, Date.now()).run();   // 署名 = 你在本團登記的角色 ID
  return json({ ok: true });
}
