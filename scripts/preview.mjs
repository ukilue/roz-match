// 本機預覽（免登入、免資料庫、無相依套件）：只提供 public/ 的靜態檔，/api 一律回 404，
// 前端會自動退回「單機模式」（資料只存在這個瀏覽器）。用來快速確認畫面改動。
// 例外：/api/servers 回傳兩個「範例伺服器」，讓側欄的伺服器選單在預覽時也看得到（正式站的清單來自遊戲廣播資料）。
// 執行：npm run preview → http://localhost:8790（可用環境變數 PORT 改埠號）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const port = Number(process.env.PORT) || 8790;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp",
};

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400); return res.end(); }
  if (pathname === "/api/servers") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ items: [{ server: "範例伺服器A", count: 0, last_ts: 0 }, { server: "範例伺服器B", count: 0, last_ts: 0 }] }));
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "本機預覽沒有 API（單機模式）" }));
  }
  const file = path.join(root, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(port, "127.0.0.1", () => console.log(`本機預覽（單機模式）：http://localhost:${port}`));
