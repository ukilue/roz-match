// GET /api/trades — 交易買賣資料的「同網域代理」（需登入 Discord）
// 交易資料由另一個 Worker（ro-broadcast）的 /trades 提供；前端若直接跨網域呼叫會被瀏覽器 CORS 擋下，
// 因此改由這支 Pages Function 在伺服器端轉呼叫，再把 JSON 原樣回給前端（同網域，不涉及 CORS）。
// 順便做到：未登入回 401（與廣播／MVP 頁一致）、只放行白名單內的查詢參數。
// 參數（原樣轉給 Worker）：side、q、item_id、since、until、limit
// Worker 網址可用環境變數 TRADES_API 覆寫（Pages 專案設定 → 環境變數），預設為下方常數。
import { json, getSession, needLogin } from "./_auth.js";

const DEFAULT_TRADES_API = "https://ro-broadcast.ukilue727.workers.dev/trades";
const ALLOWED = ["side", "q", "item_id", "since", "until", "limit"];

export async function onRequestGet({ request, env }) {
  if (!(await getSession(request, env))) return needLogin();
  const src = new URL(request.url);
  const target = new URL((env && env.TRADES_API) || DEFAULT_TRADES_API);
  for (const k of ALLOWED) {
    const v = src.searchParams.get(k);
    if (v != null && v !== "") target.searchParams.set(k, v.slice(0, 80));
  }
  try {
    const r = await fetch(target.toString(), { headers: { "Accept": "application/json" } });
    const body = await r.text();
    if (!r.ok) {
      console.log("trades upstream failed:", r.status, body.slice(0, 200));
      return withCache(json({ items: [], error: "交易資料暫時無法讀取" }, 502), 0);
    }
    const res = new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    return withCache(res, 5);   // 與 Worker 一致：瀏覽器端快取 5 秒
  } catch (e) {
    console.log("trades upstream error:", e && e.message);
    return withCache(json({ items: [], error: "交易資料暫時無法讀取" }, 502), 0);
  }
}

function withCache(res, sec) {
  res.headers.set("Cache-Control", sec > 0 ? `private, max-age=${sec}` : "no-store");
  return res;
}
