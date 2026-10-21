// GET /api/mvp — MVP 討伐／重生整理（需登入；限時公開期（MVP_PUBLIC）所有登入者可看，否則需在 mvp_viewers 表內）
// 從 broadcasts 讀出 MVP 資訊類的「騎士團偵查隊報告」，每隻 MVP（名稱＋棲息地）只留最後一次死亡時間，
// 計算預計重生（PK +2h／一般 +3h），存活中的排最前、其餘依重生時間近→遠。
// 回傳 { now, items:[{ name, habitat, killedAt, respawnAt, alive, kills }] }
import { getSession, json, needLogin } from "./_auth.js";
import { mvpAllowed, summarizeMvps } from "./_mvp.js";

// 不限時間：很久沒被擊殺的 MVP 也要列出（狀態為存活中）；只取最近 20000 筆 MVP 訊息即可涵蓋
const MAX_ROWS = 20000;

export async function onRequestGet({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!(await mvpAllowed(env, user.id))) return json({ error: "沒有查看 MVP 資訊的權限" }, 403);
  const now = Math.floor(Date.now() / 1000);
  // server：伺服器名稱（必帶）。各伺服器的 MVP 死亡／重生時間獨立，只用該伺服器的訊息計算
  const server = (new URL(request.url).searchParams.get("server") || "").trim().slice(0, 40);
  let rows = [];
  try {
    const sql = `SELECT ts, message FROM broadcasts
                 WHERE (category = 'MVP資訊' OR message LIKE '%棲息地的MVP%')${server ? " AND server = ?" : ""}
                 ORDER BY ts DESC LIMIT ?`;
    const stmt = server ? env.DB.prepare(sql).bind(server, MAX_ROWS) : env.DB.prepare(sql).bind(MAX_ROWS);
    const r = await stmt.all();
    rows = r.results || [];
  } catch (e) {
    console.log("mvp query failed:", e && e.message);
  }
  const res = json({ now, items: summarizeMvps(rows, now) });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
