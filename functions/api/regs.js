// /api/regs — GET 查詢當日登記、POST 新增登記
// 所有遊戲規則在伺服器端再驗證一次，前端無法繞過；
// token 只在建立時回傳給本人，之後的查詢絕不包含 token。

const ACTS = ["90級每日","100級朱諾毀葛每日","105級朱諾毀葛每日","副本4困1普","副本3困2普"];
const isDungeon = a => a === "副本4困1普" || a === "副本3困2普";
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const bad = (msg, status = 400) => json({ error: msg }, status);

// 以台灣時區判斷「今天」與現在時間
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
  const { results } = await env.DB
    .prepare(`SELECT uid, charId, level, job, activity, startHM AS start, endHM AS "end", date, bento, ts
              FROM regs WHERE date = ?`)
    .bind(date).all();
  return json(results.map(r => ({ ...r, bento: !!r.bento })));
}

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return bad("JSON 格式錯誤"); }

  const charId = String(b.charId || "").trim().slice(0, 24);
  const level = Number(b.level);
  const job = String(b.job || "").trim().slice(0, 20);
  const activity = String(b.activity || "");
  const start = String(b.start || "");
  const end = String(b.end || "");
  const date = String(b.date || "");
  const bento = isDungeon(activity) && b.bento ? 1 : 0;

  if (!charId || !job) return bad("資料不完整");
  if (!ACTS.includes(activity)) return bad("目標不存在");
  if (!Number.isInteger(level) || level < 1 || level > 110) return bad("角色等級須為 1～110");
  if (activity.startsWith("90級") && level < 90) return bad("此每日需 90 級以上");
  if (activity.startsWith("100級") && level < 100) return bad("此每日需 100 級以上");
  if (activity.startsWith("105級") && level < 105) return bad("此每日需 105 級以上");
  if (isDungeon(activity) && level < 90) return bad("副本需 90 級以上");
  if (!HM.test(start) || !HM.test(end)) return bad("時間格式錯誤");
  if (!DATE.test(date)) return bad("日期格式錯誤");
  if (toMin(end) <= toMin(start)) return bad("結束時間必須晚於開始時間");

  const tw = taipeiNow();
  if (date !== tw.date) return bad("只能登記今天的糾團");
  if (toMin(end) < tw.min - 5) return bad("這個時段已經過去了");

  // 防灌水：同角色同日登記數上限
  const cnt = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM regs WHERE date = ? AND charId = ?")
    .bind(date, charId).first();
  if (cnt && cnt.c >= 20) return bad("此角色今日登記次數已達上限");

  const uid = crypto.randomUUID();
  const token = crypto.randomUUID();
  await env.DB
    .prepare(`INSERT INTO regs (uid, token, charId, level, job, activity, startHM, endHM, date, bento, ts)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(uid, token, charId, level, job, activity, start, end, date, bento, Date.now())
    .run();
  return json({ uid, token });
}
