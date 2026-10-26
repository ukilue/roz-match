// POST /api/squads/lock — 隊長鎖定／解鎖自己那一團（需登入＋公會成員）
// body { uid, action: "lock" | "unlock" }
//   uid：本人在該揪團的登記 uid；伺服器重算分團後，這筆登記必須正好是所在團的隊長（含暫代）才能操作
//   lock   → 該團所有成員的 regs.lockKey 設為同一把新鍵（含建立時間，分團時依鎖定先後排序）；之後此團固定不動、不再加人
//   unlock → 清掉該鍵；成員重新回到一般分團
import { getSession, json, needLogin, needMember } from "../_auth.js";
import { buildParties } from "../_party.js";

export async function onRequestPost({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();
  let b; try { b = await request.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400); }
  const uid = String(b.uid || ""), action = String(b.action || "");
  if (!uid || !["lock", "unlock"].includes(action)) return json({ error: "參數錯誤" }, 400);

  const mine = await env.DB.prepare("SELECT uid, discordId, date, removed FROM regs WHERE uid = ?").bind(uid).first();
  if (!mine || mine.removed) return json({ error: "找不到這筆登記" }, 404);
  if (mine.discordId !== user.id) return json({ error: "只能操作自己的登記" }, 403);

  const { results } = await env.DB
    .prepare(`SELECT uid, discordId, charId, level, job, activity, startHM AS start, endHM AS "end", date, skills, removed, removedTs, room, roomOpen, leader, lockKey, ts
              FROM regs WHERE date = ?`).bind(mine.date).all();
  const rows = results.map(r => ({ ...r, skills: String(r.skills || "").split(",").filter(Boolean), removed: !!r.removed, room: r.room || "", roomOpen: !!r.roomOpen, leader: r.leader == null ? true : !!r.leader, lockKey: r.lockKey || "" }));
  const party = buildParties(rows, mine.date).find(p => p.members.some(m => m.uid === uid));
  const squad = party && party.squads.find(s => s.members.some(m => m.uid === uid));
  if (!squad) return json({ error: "找不到所在的隊伍" }, 404);
  if (!squad.leader || squad.leader.uid !== uid) return json({ error: "只有該團隊長可以鎖定／解鎖" }, 403);

  if (action === "lock") {
    if (squad.locked) return json({ ok: true, locked: true, lockKey: squad.lockKey });
    const key = String(Date.now()).padStart(14, "0") + "-" + crypto.randomUUID().slice(0, 8);
    const uids = squad.members.map(m => m.uid);
    await env.DB.prepare(`UPDATE regs SET lockKey = ? WHERE removed = 0 AND uid IN (${uids.map(() => "?").join(",")})`).bind(key, ...uids).run();
    return json({ ok: true, locked: true, lockKey: key });
  }
  if (!squad.locked) return json({ ok: true, locked: false });
  await env.DB.prepare("UPDATE regs SET lockKey = '' WHERE lockKey = ?").bind(squad.lockKey).run();
  return json({ ok: true, locked: false });
}
