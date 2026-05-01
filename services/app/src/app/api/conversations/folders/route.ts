/**
 * Folders de conversations — couche locale BoxIA (Dify n'expose rien).
 *
 * GET /api/conversations/folders
 *   → { folders: Folder[], assignments: { <conv_id>: <folder_id|null> } }
 *
 * POST /api/conversations/folders
 *   body : { action: "create", name: string, color?: string }
 *        | { action: "rename", folder_id: string, name: string, color?: string }
 *        | { action: "delete", folder_id: string }
 *        | { action: "assign", conversation_id: string, folder_id: string | null }
 *   → { ok, folders, assignments }
 *
 * Auth : session NextAuth requise (folders scopés par user_email).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  listFolders,
  getAssignments,
  createFolder,
  updateFolder,
  deleteFolder,
  assignConversation,
} from "@/lib/conversation-folders";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [folders, assignments] = await Promise.all([
    listFolders(email),
    getAssignments(email),
  ]);
  return NextResponse.json({ folders, assignments });
}

interface PostBody {
  action?: string;
  name?: string;
  color?: string;
  folder_id?: string;
  conversation_id?: string;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  switch (body.action) {
    case "create": {
      if (!body.name || typeof body.name !== "string") {
        return NextResponse.json({ error: "missing_name" }, { status: 400 });
      }
      const f = await createFolder(email, body.name, body.color);
      if (!f) return NextResponse.json({ error: "create_failed" }, { status: 500 });
      const [folders, assignments] = await Promise.all([
        listFolders(email),
        getAssignments(email),
      ]);
      return NextResponse.json({ ok: true, folder: f, folders, assignments });
    }
    case "rename": {
      if (!body.folder_id) {
        return NextResponse.json({ error: "missing_folder_id" }, { status: 400 });
      }
      const f = await updateFolder(email, body.folder_id, {
        name: body.name,
        color: body.color,
      });
      if (!f) return NextResponse.json({ error: "not_found" }, { status: 404 });
      const folders = await listFolders(email);
      return NextResponse.json({ ok: true, folder: f, folders });
    }
    case "delete": {
      if (!body.folder_id) {
        return NextResponse.json({ error: "missing_folder_id" }, { status: 400 });
      }
      await deleteFolder(email, body.folder_id);
      const [folders, assignments] = await Promise.all([
        listFolders(email),
        getAssignments(email),
      ]);
      return NextResponse.json({ ok: true, folders, assignments });
    }
    case "assign": {
      if (!body.conversation_id) {
        return NextResponse.json({ error: "missing_conversation_id" }, { status: 400 });
      }
      // folder_id peut être null pour désassigner
      const fid = body.folder_id === undefined ? null : body.folder_id;
      await assignConversation(email, body.conversation_id, fid);
      const assignments = await getAssignments(email);
      return NextResponse.json({ ok: true, assignments });
    }
    default:
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
}
