import { hidePress } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Moderation: DELETE /api/admin/press?id=42
 * Header: Authorization: Bearer $ADMIN_TOKEN
 * Removes the press from the public ledger (the minimum price is kept).
 */
export async function DELETE(request: Request) {
  const token = process.env.ADMIN_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  if (!token || auth !== `Bearer ${token}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) {
    return Response.json({ error: "id required" }, { status: 400 });
  }
  const state = await hidePress(id);
  return Response.json({
    ok: true,
    holder: state.holder,
    presses: state.presses.length,
  });
}
