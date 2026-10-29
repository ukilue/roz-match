// GET /api/events — 活動日程（不需登入；資料由 D1 的 events 表維護，見 schema.sql）
// 參數：from、to（Unix 秒，必帶；回傳與 [from, to) 有重疊的活動，範圍最長 120 天）
// 回傳 { items:[{ id, title, start, end, url, note }] }，依開始時間排序；瀏覽器快取 60 秒。不分伺服器。
import { json } from "./_auth.js";

const MAX_RANGE = 120 * 86400;

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const from = Number(u.searchParams.get("from")) || 0;
  let to = Number(u.searchParams.get("to")) || 0;
  if (!from || !to || to <= from) return json({ error: "from / to 參數錯誤" }, 400);
  if (to - from > MAX_RANGE) to = from + MAX_RANGE;
  try {
    const { results } = await env.DB
      .prepare(`SELECT id, title, start_ts, end_ts, url, note FROM events
                WHERE enabled = 1 AND start_ts < ? AND end_ts > ?
                ORDER BY start_ts ASC, end_ts DESC, id ASC`)
      .bind(to, from).all();
    const items = results.map(r => ({
      id: r.id, title: r.title || "", start: r.start_ts, end: r.end_ts,
      url: /^https?:\/\//i.test(r.url || "") ? r.url : "",   // 只允許 http(s) 連結
      note: r.note || "",
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
