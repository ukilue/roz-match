// GET /api/events — 活動日程（不需登入；資料由 D1 的 events 表維護，見 schema.sql）
// 參數：from、to（Unix 秒，必帶；回傳與 [from, to) 有重疊的活動，範圍最長 120 天）
//       server（伺服器名稱；回傳該伺服器專屬＋所有伺服器共用（server 為空字串）的活動）
// 回傳 { items:[{ id, title, start, end, url, note, kind, server }] }，依開始時間排序；瀏覽器快取 60 秒
import { json } from "./_auth.js";

const KINDS = ["一般", "限時副本", "PVP", "加倍"];
const MAX_RANGE = 120 * 86400;

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const from = Number(u.searchParams.get("from")) || 0;
  let to = Number(u.searchParams.get("to")) || 0;
  const server = (u.searchParams.get("server") || "").trim().slice(0, 40);
  if (!from || !to || to <= from) return json({ error: "from / to 參數錯誤" }, 400);
  if (to - from > MAX_RANGE) to = from + MAX_RANGE;
  try {
    const { results } = await env.DB
      .prepare(`SELECT id, title, start_ts, end_ts, url, note, kind, server FROM events
                WHERE enabled = 1 AND start_ts < ? AND end_ts > ? AND (server = '' OR server = ?)
                ORDER BY start_ts ASC, end_ts DESC, id ASC`)
      .bind(to, from, server).all();
    const items = results.map(r => ({
      id: r.id, title: r.title || "", start: r.start_ts, end: r.end_ts,
      url: /^https?:\/\//i.test(r.url || "") ? r.url : "",   // 只允許 http(s) 連結
      note: r.note || "", kind: KINDS.includes(r.kind) ? r.kind : "一般", server: r.server || "",
    }));
    const res = json({ items });
    res.headers.set("Cache-Control", "public, max-age=60");
    return res;
  } catch (e) {
    console.log("events query failed:", e && e.message);   // 資料表尚未建立等：回空清單
    const res = json({ items: [], error: "活動資料暫時無法讀取" });
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
