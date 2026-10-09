// GET /api/broadcasts — 遊戲內廣播訊息（不需登入）
// 資料由另一支程式寫入 D1 的 broadcasts 表（見 schema.sql），本端點只讀。
// 參數：
//   cat    分類：交易買賣 / 組隊資訊 / 系統公告 / 其他閒聊（省略或不合法＝全部；「MVP資訊」一律不回傳）
//   q      關鍵字（比對訊息內容與發話者，不分大小寫；最多 60 字）
//   before 只取 ts 小於此值（Unix 秒）的訊息，用於「載入更多」
//   limit  一次幾筆（1～100，預設 50）
// 只回傳最近 7 天內的訊息，依時間新→舊。回傳 { items:[{id, ts, type, sender, message, category}], hasMore, since }
import { json } from "./_auth.js";

export const BC_CATS = ["交易買賣", "組隊資訊", "系統公告", "其他閒聊"];
export const BC_HIDDEN = "MVP資訊";
export const BC_DAYS = 7;

const noStore = (data, status = 200) => {
  const r = json(data, status);
  r.headers.set("Cache-Control", "no-store");
  return r;
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const cat = url.searchParams.get("cat") || "";
  const q = (url.searchParams.get("q") || "").trim().slice(0, 60);
  const before = Number(url.searchParams.get("before")) || 0;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const since = Math.floor(Date.now() / 1000) - BC_DAYS * 86400;

  const where = ["ts >= ?"];
  const args = [since];
  if (BC_CATS.includes(cat)) { where.push("category = ?"); args.push(cat); }
  else { where.push("(category IS NULL OR category != ?)"); args.push(BC_HIDDEN); }   // 全部：排除 MVP 資訊
  if (before > 0) { where.push("ts < ?"); args.push(before); }
  if (q) {
    // LIKE 萬用字元跳脫，讓使用者輸入的 % _ 當一般字元比對
    const like = "%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%";
    where.push("(message LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  try {
    const { results } = await env.DB
      .prepare(`SELECT id, ts, type, sender, message, category FROM broadcasts
                WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`)
      .bind(...args, limit + 1).all();
    const hasMore = results.length > limit;
    const items = results.slice(0, limit).map(r => ({
      id: r.id, ts: r.ts, type: r.type || "", sender: r.sender || "", message: r.message || "",
      category: BC_CATS.includes(r.category) ? r.category : "其他閒聊",
    }));
    return noStore({ items, hasMore, since });
  } catch (e) {
    // 資料表尚未建立或查詢失敗：回空清單，前端顯示「目前沒有廣播」而不是整頁壞掉
    console.log("broadcasts query failed:", e && e.message);
    return noStore({ items: [], hasMore: false, since, error: "廣播資料暫時無法讀取" });
  }
}
