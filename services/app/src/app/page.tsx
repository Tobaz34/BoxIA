/**
 * Page principale = Chat plein écran (l'expérience utilisateur).
 * Branché sur /api/chat → Dify (streaming SSE).
 */
import { Chat } from "@/components/Chat";

export default function HomePage() {
  return <Chat />;
}
