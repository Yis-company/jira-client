import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { edits, type WorkspaceChangeEvent } from "../lib/edits";
import type { Session } from "../lib/bridge";
import { requestEditSync } from "../lib/editSync";

export function ownerKey(session: Session) {
  return `${normalizeSite(session.siteUrl)}:${session.email.trim().toLowerCase()}`;
}

export function useEditRuntime(session: Session | null | undefined, accountKey: string) {
  const client = useQueryClient();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!session || !accountKey) return;
    let current = true;
    const wake = () => {
      if (!navigator.onLine) return;
      setError("");
      void requestEditSync(accountKey)
        .then(() => {
          if (current) return client.invalidateQueries({ queryKey: ["changes", accountKey] });
        })
        .catch((cause) => {
          if (current) setError(errorMessage(cause));
        });
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") wake();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") wake();
    }, 60_000);
    window.addEventListener("online", wake);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    wake();
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [accountKey, client, session]);

  useEffect(() => {
    if (!session || !accountKey) return;
    let current = true;
    let unlisten: (() => void) | undefined;
    const handle = (event: WorkspaceChangeEvent) => {
      if (!current || normalizeSite(event.owner.siteUrl) !== normalizeSite(session.siteUrl) || event.owner.email.trim().toLowerCase() !== session.email.trim().toLowerCase()) return;
      void Promise.all([
        client.invalidateQueries({ queryKey: ["changes", accountKey] }),
        client.invalidateQueries({ queryKey: ["workspace-list", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-workspace", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issues", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issue", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-daily", accountKey] }),
        client.invalidateQueries({ queryKey: ["issue-capabilities", accountKey] }),
      ]);
    };
    void edits.subscribe(handle).then((stop) => {
      if (current) unlisten = stop;
      else stop();
    }).catch(() => undefined);
    return () => {
      current = false;
      unlisten?.();
    };
  }, [accountKey, client, session]);

  return error;
}

function normalizeSite(siteUrl: string) {
  return siteUrl.trim().toLowerCase().replace(/\/+$/, "");
}

function errorMessage(cause: unknown) {
  return typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "Could not sync pending changes.";
}
