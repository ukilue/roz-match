// GET /api/servers — 伺服器清單（不需登入；同網域代理 ro-broadcast Worker 的 /servers）
// 回傳 { items:[{ server, count, last_ts }] }，依 last_ts 新→舊；「未設定」（來源無法判斷的資料）不回傳。
// 伺服器名稱一律來自 Worker，不寫死在程式裡。瀏覽器快取 60 秒。
import { json } from "./_auth.js";

const DEFAULT_TRADES_API = "https://ro-broadcast.ukilue727.workers.dev/trades";
const HIDDEN = "未設定";

export async function onRequestGet({ env }) {
  const base = ((env && env.TRADES_API) || DEFAULT_TRADES_API).replace(/\/trades\/?$/, "");
  try {
    const r = await fetch(base + "/servers", { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const items = (Array.isArray(d) ? d : (d.items || []))
      .filter(s => s && s.server && s.server !== HIDDEN)
      .map(s => ({ server: String(s.server), count: Number(s.count) || 0, last_ts: Number(s.last_ts) || 0 }))
      .sort((a, b) => b.last_ts - a.last_ts);
    const res = json({ items });
    res.headers.set("Cache-Control", "public, max-age=60");
    return res;
  } catch (e) {
    console.log("servers upstream failed:", e && e.message);
    const res = json({ items: [], error: "伺服器清單暫時無法讀取" }, 502);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
