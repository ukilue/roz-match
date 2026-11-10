// GET /api/coupons — 序號領取（不需登入；資料由 D1 的 coupons 表維護，見 schema.sql）
// 回傳 { now, items:[{ id, name, code, rewards:[…], expire, note }] }，依 sort、id 新→舊；瀏覽器快取 60 秒
import { json } from "./_auth.js";

export async function onRequestGet({ env }) {
  const now = Math.floor(Date.now() / 1000);
  try {
    const { results } = await env.DB
      .prepare(`SELECT id, name, code, reward, expire_ts, note FROM coupons WHERE enabled = 1 ORDER BY sort ASC, id DESC`)
      .all();
    const items = results.map(r => ({
      id: r.id, name: r.name || "", code: r.code || "",
      rewards: String(r.reward || "").split(/[、\n]/).map(s => s.trim()).filter(Boolean),
      expire: r.expire_ts == null ? null : Number(r.expire_ts), note: r.note || "",
    }));
    const res = json({ now, items });
    res.headers.set("Cache-Control", "public, max-age=60");
    return res;
  } catch (e) {
    console.log("coupons query failed:", e && e.message);   // 資料表尚未建立等：回空清單
    const res = json({ now, items: [], error: "序號資料暫時無法讀取" });
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}
