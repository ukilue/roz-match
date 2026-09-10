// DELETE /api/regs/:uid — 退出揪團（軟刪除）
// 需登入 Discord，且這筆登記必須是本人帳號建立的。
// 採軟刪除（removed=1）而非真刪：退出者仍作為揪團編號的錨點，
// 創團者退出後編號、留言板都不會變動；7 天後由排程器實際清除。
import { getSession, json, needLogin, needMember } from "../_auth.js";

export async function onRequestDelete({ request, env, params }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();

  const uid = String(params.uid || "");
  if (!uid) return json({ error: "缺少參數" }, 400);

  const row = await env.DB.prepare("SELECT discordId, removed FROM regs WHERE uid = ?").bind(uid).first();
  if (!row) return json({ error: "找不到這筆登記" }, 404);
  if (row.discordId !== user.id) return json({ error: "只能退出自己 Discord 帳號登記的揪團" }, 403);

  await env.DB.prepare("UPDATE regs SET removed = 1 WHERE uid = ?").bind(uid).run();
  return json({ deleted: true });
}

// PATCH /api/regs/:uid — 手動微調預期分團：body { dir: 1 | -1 }（↓ 移到下一團／↑ 移到上一團）
// 只限「副本」揪團；只能移動自己 Discord 帳號登記的角色；已關閉（已出發或時段結束）的揪團不可再調整。
// 結果寫入 regs.squad（目標團序），三端演算法在系統分配之後套用，所以網站、機器人私訊、語音房一致。
import { buildParties, taipeiNow, isDungeon } from "../_party.js";
export async function onRequestPatch({ request, env, params }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();
  const uid = String(params.uid || "");
  let b; try { b = await request.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400); }
  const dir = Number(b.dir);
  if (dir !== 1 && dir !== -1) return json({ error: "參數錯誤" }, 400);

  const tw = taipeiNow();
  const { results } = await env.DB
    .prepare(`SELECT uid, discordId, charId, level, job, activity, startHM AS start, endHM AS "end", date, bento, role, removed, squad, ts
              FROM regs WHERE date = ?`)
    .bind(tw.date).all();
  const parties = buildParties(results.map(r => ({ ...r, bento: !!r.bento, role: r.role || "", removed: !!r.removed, squad: r.squad == null ? null : Number(r.squad) })), tw.date);
  const party = parties.find(p => p.members.some(m => m.uid === uid));
  if (!party) return json({ error: "找不到這筆登記所屬的揪團" }, 404);
  const target0 = party.members.find(m => m.uid === uid);
  if (!target0 || target0.discordId !== user.id) return json({ error: "只能移動自己 Discord 帳號登記的角色" }, 403);
  if (!isDungeon(party.activity)) return json({ error: "只有副本揪團可以手動調整分團" }, 400);
  const closed = (party.ok && party.departMin != null && tw.min >= party.departMin) || party.timeEnd < tw.min;
  if (closed) return json({ error: "此揪團已關閉，無法再調整分團" }, 400);
  if (party.squads.length < 2) return json({ error: "此揪團目前只有一團，不需調整" }, 400);

  const cur = party.squads.find(s => s.members.some(m => m.uid === uid)).index;
  const target = cur + dir;
  if (target < 1 || target > party.squads.length) return json({ error: cur === 1 ? "已在第 1 團" : "已在最後一團" }, 400);
  await env.DB.prepare("UPDATE regs SET squad = ? WHERE uid = ?").bind(target, uid).run();
  return json({ ok: true, squad: target });
}
