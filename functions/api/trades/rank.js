// GET /api/trades/rank?server=&range=day|week|month — 交易排行（需登入）
// 直接查 D1 的 trades JOIN broadcasts：統計區間內每個道具被「多少位不同玩家」喊收購／販賣，各取前 10 名。
//   ・只計有對應到道具的交易（排除 match_type 未對應、貨幣）
//   ・同一玩家重複喊同一道具只算 1 人（COUNT(DISTINCT sender)），避免洗頻灌水
//   ・以 item_id 分組（同一道具的不同簡稱合併）；item_id 為空時退而以 item_name 分組
// 回傳 { server, range, since, buy:[{ item_id, item_name, count }], sell:[…] }；瀏覽器快取 60 秒
// 建議索引：CREATE INDEX IF NOT EXISTS idx_trades_server_ts ON trades(server, ts);
import { getSession, json, needLogin } from "../_auth.js";

const RANGES = { day: 86400, week: 7 * 86400, month: 30 * 86400 };
const TOP_N = 10;

export async function onRequestGet({ request, env }) {
  if (!(await getSession(request, env))) return needLogin();
  const u = new URL(request.url);
  const server = (u.searchParams.get("server") || "").trim().slice(0, 40);
  const range = RANGES[u.searchParams.get("range")] ? u.searchParams.get("range") : "day";
  const since = Math.floor(Date.now() / 1000) - RANGES[range];
  const sql = `
    SELECT t.item_id AS item_id, MAX(t.item_name) AS item_name, COUNT(DISTINCT b.sender) AS cnt
    FROM trades AS t INNER JOIN broadcasts AS b ON t.broadcast_id = b.id
    WHERE t.server = ? AND t.ts >= ? AND t.side = ?
      AND t.match_type NOT IN ('未對應', '貨幣')
    GROUP BY COALESCE(CAST(t.item_id AS TEXT), t.item_name)
    ORDER BY cnt DESC, MAX(t.ts) DESC
    LIMIT ?`;
  const top = async side => {
    const { results } = await env.DB.prepare(sql).bind(server, since, side, TOP_N).all();
    return results.map(r => ({ item_id: r.item_id, item_name: r.item_name || "", count: Number(r.cnt) || 0 }));
  };
  try {
    const [buy, sell] = await Promise.all([top("收購"), top("販賣")]);
    const res = json({ server, range, since, buy, sell });
    res.headers.set("Cache-Control", "private, max-age=60");
    return res;
  } catch (e) {
    console.log("trade rank failed:", e && e.message);
    const res = json({ server, range, since, buy: [], sell: [], error: "排行資料暫時無法讀取" });
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
