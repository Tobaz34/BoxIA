/**
 * GET /api/connectors — liste enrichie : catalogue + état persistant.
 *
 * ?status=active|inactive|hidden  → filtre
 * ?category=storage|email|...     → filtre
 *
 * Le sidebar (ConnectorsStatus) consomme cet endpoint avec ?status=active
 * pour ne montrer que les connecteurs vraiment branchés. La page
 * /connectors consomme la version complète pour permettre activation.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { publicCatalog, CATEGORIES } from "@/lib/connectors";
import { listStates, publicState, type ConnectorStatus } from "@/lib/connectors-state";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const filterStatus = searchParams.get("status") as ConnectorStatus | null;
  const filterCategory = searchParams.get("category");

  const states = await listStates();
  const catalog = publicCatalog();

  const items = catalog.map((spec) => {
    const st = states[spec.slug];
    const status: ConnectorStatus = st?.status || "inactive";
    return {
      ...spec,
      status,
      // Public state (jamais les valeurs secrètes)
      state: st ? publicState(spec.slug, st) : null,
    };
  });

  let filtered = items;
  if (filterStatus) {
    filtered = filtered.filter((i) => i.status === filterStatus);
  }
  if (filterCategory) {
    filtered = filtered.filter((i) => i.category === filterCategory);
  }

  return NextResponse.json({
    connectors: filtered,
    categories: CATEGORIES,
    summary: {
      total: items.length,
      active: items.filter((i) => i.status === "active").length,
      hidden: items.filter((i) => i.status === "hidden").length,
    },
  });
}
