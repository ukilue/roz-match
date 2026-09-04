// /api/regs — GET 查詢當日登記、POST 新增登記（需 Discord 登入＋公會伺服器成員）
// 所有遊戲規則在伺服器端再驗證一次，前端無法繞過；
// 登記會綁定 Discord 帳號，退團只有本人帳號可操作。
import { getSession, needLogin, needMember } from "./_auth.js";
import { buildParties } from "./_party.js";

const ACTS = ["90級每日","100級每日","100+105級每日","90級↑副本4困1普","90級↑副本3困2普","80級↑副本3困1普"];
const ROLES = ["大腿","坦","補","打","便當"];
const LEVEL_REQ = { "90級每日":90, "100級每日":100, "100+105級每日":105, "90級↑副本4困1普":90, "90級↑副本3困2普":90, "80級↑副本3困1普":80 };
const isDungeon = a => a === "90級↑副本4困1普" || a === "90級↑副本3困2普" || a === "80級↑副本3困1普";
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const bad = (msg, status = 400) => json({ error: msg }, status);

// 以台灣時區判斷「今天」與現在時間；查詢絕不回傳 discordId（防對照身分）
function taipeiNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    min: Number(get("hour")) % 24 * 60 + Number(get("minute"))
  };
}
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

export async function onRequestGet({ request, env }) {
  const date = new URL(request.url).searchParams.get("date") || "";
  if (!DATE.test(date)) return bad("date 格式錯誤");
  const user = await getSession(request, env);   // 有登入的話，標記哪些登記是本人的
  const { results } = await env.DB
    .prepare(`SELECT uid, discordId, charId, level, job, activity, startHM AS start, endHM AS "end", date, bento, role, removed, ts
              FROM regs WHERE date = ?`)
    .bind(date).all();
  return json(results.map(({ discordId, ...r }) =>
    ({ ...r, bento: !!r.bento, role: r.role || "", removed: !!r.removed, mine: !!(user && discordId === user.id) })));
}

export async function onRequestPost({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();

  let b;
  try { b = await request.json(); } catch { return bad("JSON 格式錯誤"); }

  const charId = String(b.charId || "").trim().slice(0, 24);
  const level = Number(b.level);
  const job = String(b.job || "").trim().slice(0, 20);
  const activity = String(b.activity || "");
  const start = String(b.start || "");
  const end = String(b.end || "");
  const date = String(b.date || "");
  let role = "";
  if (isDungeon(activity)) {
    role = String(b.role || "打");
    if (!ROLES.includes(role)) return bad("副本職責選項錯誤");
  }
  const bento = role === "便當" ? 1 : 0;

  if (!charId || !job) return bad("資料不完整");
  if (!ACTS.includes(activity)) return bad("目標不存在");
  if (!Number.isInteger(level) || level < 1 || level > 110) return bad("角色等級須為 1～110");
  const needLv = LEVEL_REQ[activity];
  if (needLv && level < needLv) return bad(`此活動需 ${needLv} 級以上`);
  if (!HM.test(start) || !HM.test(end)) return bad("時間格式錯誤");
  if (!DATE.test(date)) return bad("日期格式錯誤");
  if (toMin(end) <= toMin(start)) return bad("結束時間必須晚於開始時間");

  const tw = taipeiNow();
  if (date !== tw.date) return bad("只能登記今天的揪團");
  if (toMin(end) < tw.min - 5) return bad("這個時段已經過去了");
  // 開始時間已過的登記＝「加入」已在進行時段的團：
  // 只有「已成團且已開團」的團關閉收人；還在揪團中（未成團）的團持續收人
  if (toMin(start) < tw.min - 2) {
    const { results: all } = await env.DB
      .prepare(`SELECT uid, discordId, charId, level, job, activity, startHM AS start, endHM AS "end", date, bento, role, removed, ts
                FROM regs WHERE date = ?`)
      .bind(date).all();
    const parties = buildParties(all.map(r => ({ ...r, bento: !!r.bento, role: r.role || "", removed: !!r.removed })), date);
    const target = parties.find(p => p.activity === activity && p.time === toMin(start) && p.timeEnd === toMin(end));
    if (!target) return bad("此時段已開始，無法登記");
    if (target.ok && target.departMin != null && tw.min >= target.departMin) return bad("此團已出發並關閉揪團，不再接受新成員加入");
    // 揪團中或緩衝期（即將出發）→ 允許加入
  }

  // 同一帳號不能同時報兩個「時段重疊」的團（人不可能同時在兩處）
  const { results: myRegs } = await env.DB
    .prepare("SELECT startHM, endHM, activity FROM regs WHERE date = ? AND discordId = ? AND removed = 0")
    .bind(date, user.id).all();
  const ns = toMin(start), ne = toMin(end);
  for (const r of myRegs) {
    const os = toMin(r.startHM), oe = toMin(r.endHM);
    if (ns < oe && os < ne) {
      return bad(`你已在 ${r.startHM}～${r.endHM} 登記「${r.activity}」，時段重疊無法再登記；若要改時段請先退出原團`);
    }
  }

  // 防灌水：同 Discord 帳號同日登記數上限
  const cnt = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM regs WHERE date = ? AND discordId = ?")
    .bind(date, user.id).first();
  if (cnt && cnt.c >= 20) return bad("你今日的登記次數已達上限");

  const uid = crypto.randomUUID();
  await env.DB
    .prepare(`INSERT INTO regs (uid, discordId, charId, level, job, activity, startHM, endHM, date, bento, role, ts)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(uid, user.id, charId, level, job, activity, start, end, date, bento, role, Date.now())
    .run();
  return json({ uid });
}
