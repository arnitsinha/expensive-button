import { sessionStatus } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/checkout?session_id=cs_... -> { status: pressed|refunded|pending } */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("session_id") ?? "";
  if (!/^[\w-]{1,200}$/.test(id)) {
    return Response.json({ error: "bad session_id" }, { status: 400 });
  }
  return Response.json(
    { status: await sessionStatus(id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
