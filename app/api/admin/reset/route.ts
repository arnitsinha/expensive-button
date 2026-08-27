import { resetState } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Wipe the ledger back to a fresh $1 button.
 * POST /api/admin/reset   Header: Authorization: Bearer $ADMIN_TOKEN
 */
export async function POST(request: Request) {
  const token = process.env.ADMIN_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  if (!token || auth !== `Bearer ${token}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const state = await resetState();
  return Response.json({
    ok: true,
    price: state.price,
    presses: state.presses.length,
  });
}
