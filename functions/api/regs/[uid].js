// DELETE /api/regs/:uid — 退出糾團
// 必須附上登記時發放的 token（存在登記者自己的瀏覽器），
// 沒有 token 無法刪除任何人的登記 → 從根本杜絕惡意幫別人退團。

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export async function onRequestDelete({ request, env, params }) {
  const uid = String(params.uid || "");
  const token = request.headers.get("X-Token") || "";
  if (!uid || !token) return json({ error: "缺少驗證資訊" }, 400);

  const row = await env.DB.prepare("SELECT token FROM regs WHERE uid = ?").bind(uid).first();
  if (!row) return json({ error: "找不到這筆登記" }, 404);
  if (row.token !== token) return json({ error: "只能退出自己登記的糾團" }, 403);

  await env.DB.prepare("DELETE FROM regs WHERE uid = ?").bind(uid).run();
  return json({ deleted: true });
}
