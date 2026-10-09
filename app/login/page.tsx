import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { login } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { error } = await searchParams;
  return (
    <main style={{ maxWidth: 360, margin: "12vh auto", padding: 24 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Suzali Conseil · Calls</h1>
      <p style={{ color: "#9aa1af", marginTop: 0 }}>Connectez-vous pour accéder au tableau de bord des appels.</p>
      <form action={login} className="form">
        <label>
          Email
          <input name="email" type="email" required autoComplete="username" autoFocus />
        </label>
        <label>
          Mot de passe
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        {error && <p className="err">Identifiants incorrects, ou compte temporairement bloqué.</p>}
        <button type="submit">Se connecter</button>
      </form>
    </main>
  );
}
