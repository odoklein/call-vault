import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireUser();
  redirect(user.role === "ADMIN" ? "/admin" : "/board");
}
