"use server";

import { redirect } from "next/navigation";
import { checkCredentials } from "@/lib/auth/login";
import { createSession, destroySession } from "@/lib/auth/session";

export async function login(formData: FormData) {
  const user = await checkCredentials(String(formData.get("email") ?? ""), String(formData.get("password") ?? ""));
  if (!user) redirect("/login?error=1");
  await createSession(user.id);
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
