// functions/api/_mvp.js — MVP 資訊共用：觀看權限查詢、廣播訊息解析、重生時間計算
//
// 權限：D1 的 mvp_viewers 表只有一個欄位 discordId；帳號在表內才看得到「MVP 資訊」頁（schema.sql）。
// 訊息格式（騎士團偵查隊報告）：
//   【騎士團偵查隊報告】快報!快報!!PK棲息地的MVP骷髏迪塔勒泰晤勒斯已被冒險家討伐，地域恢復了穩定。
//   【騎士團偵查隊報告】快報!快報!!一般棲息地的MVP蟻后已被冒險家討伐，地域恢復了穩定。
// 死亡時間＝broadcasts.ts（Unix 秒）；重生＝PK 棲息地 +2 小時、一般棲息地 +3 小時。

export const RESPAWN_SEC = { PK: 2 * 3600, "一般": 3 * 3600 };

// 可被授權查看 MVP 頁的帳號；表不存在時一律 false
export async function canViewMvp(env, discordId) {
  if (!discordId) return false;
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok FROM mvp_viewers WHERE discordId = ?").bind(String(discordId)).first();
    return !!row;
  } catch (e) { return false; }
}

// 解析一則 MVP 廣播 → { habitat:"PK"|"一般", name } 或 null（非討伐訊息）
const MVP_RE = /(PK|一般)\s*棲息地的\s*MVP\s*(.+?)\s*已被冒險家討伐/;
export function parseMvp(message) {
  const m = MVP_RE.exec(String(message || ""));
  if (!m) return null;
  return { habitat: m[1], name: m[2].trim() };
}

// rows：[{ts, message}]（任意順序）→ 每隻 MVP（名稱＋棲息地）只留最後一次死亡，附重生時間與狀態
// 排序：存活中（重生時間已過、尚未再被擊殺）排最上面（存活越久越前面），其餘依預計重生時間近→遠
export function summarizeMvps(rows, nowSec) {
  const map = new Map();
  for (const r of rows) {
    const p = parseMvp(r.message);
    if (!p) continue;
    const key = p.habitat + "|" + p.name;
    const cur = map.get(key);
    if (!cur || r.ts > cur.killedAt) {
      map.set(key, { name: p.name, habitat: p.habitat, killedAt: r.ts, kills: (cur ? cur.kills : 0) + 1 });
    } else cur.kills++;
  }
  const list = [...map.values()].map(m => {
    const respawnAt = m.killedAt + RESPAWN_SEC[m.habitat];
    return { ...m, respawnAt, alive: nowSec >= respawnAt };
  });
  list.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return a.respawnAt - b.respawnAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return list;
}
