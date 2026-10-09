"use client";

import { useActionState } from "react";
import type { ActionResult } from "./actions";

/** A form whose server action may return a one-time secret (password / API key) to display. */
export function SecretForm({
  action,
  children,
  submit,
}: {
  action: (prev: ActionResult, f: FormData) => Promise<ActionResult>;
  children?: React.ReactNode;
  submit: string;
}) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <form action={run} className="inline-form">
      {children}
      <button type="submit" disabled={pending}>
        {submit}
      </button>
      {state.error && <span className="err">{state.error}</span>}
      {state.note && !state.secret && <span className="ok">{state.note}</span>}
      {state.secret && (
        <div className="secret">
          <div>{state.note}</div>
          <code>{state.secret}</code>
        </div>
      )}
    </form>
  );
}
