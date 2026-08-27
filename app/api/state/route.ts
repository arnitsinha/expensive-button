import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getState(), {
    headers: { "Cache-Control": "no-store" },
  });
}
