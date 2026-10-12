// GET /api/config — 不需登入的公開設定（前端在登入前也要知道哪些頁面可顯示）
// 目前只有 mvpPublic：MVP 資訊是否限時公開（所有登入 Discord 的玩家可看）。不含任何密鑰或內部網址。
import { json } from "./_auth.js";
import { MVP_PUBLIC } from "./_mvp.js";

export async function onRequestGet() {
  const r = json({ mvpPublic: MVP_PUBLIC });
  r.headers.set("Cache-Control", "no-store");
  return r;
}
