import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChangeField, ChangeRequest, PendingChange } from "../lib/edits";
import { edits } from "../lib/edits";
import type { WorkspaceKey } from "../lib/workspace";
import { requestEditSync } from "../lib/editSync";

export function useIssueEditMutation({
  accountKey,
  workspaceKey,
  issueId,
}: {
  accountKey: string;
  workspaceKey: WorkspaceKey;
  issueId: string;
}) {
  const client = useQueryClient();
  const [saving, setSaving] = useState<ChangeField | null>(null);
  const [saveError, setSaveError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [notice, setNotice] = useState("");
  const identity = JSON.stringify([
    accountKey,
    workspaceKey.projectKey,
    workspaceKey.boardId,
    issueId,
  ]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  useEffect(() => {
    setSaving(null);
    setSaveError("");
    setSyncError("");
    setNotice("");
  }, [identity]);

  async function save(change: ChangeRequest) {
    const submittedFor = identity;
    setSaving(change.field);
    setSaveError("");
    setSyncError("");
    setNotice("");
    try {
      const queued = await edits.enqueue(
        workspaceKey,
        issueId,
        change,
        accountKey,
      );
      if (currentIdentity.current === submittedFor) {
        setNotice(queued ? "Saved locally" : "Queued change cancelled");
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ["cached-issues", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issue", accountKey] }),
        client.invalidateQueries({ queryKey: ["changes", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-daily", accountKey] }),
      ]);
      void requestEditSync(accountKey).catch((cause) => {
        if (currentIdentity.current === submittedFor)
          setSyncError(errorMessage(cause));
      });
      return queued;
    } catch (cause) {
      const message = errorMessage(cause);
      if (currentIdentity.current === submittedFor) setSaveError(message);
      return undefined;
    } finally {
      if (currentIdentity.current === submittedFor) setSaving(null);
    }
  }

  async function cancel(change: PendingChange) {
    const submittedFor = identity;
    setSaving(change.field);
    setSaveError("");
    setSyncError("");
    setNotice("");
    try {
      await edits.resolve(change.id, "discard");
      if (currentIdentity.current === submittedFor)
        setNotice("Queued change cancelled");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["cached-issues", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issue", accountKey] }),
        client.invalidateQueries({ queryKey: ["changes", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-daily", accountKey] }),
      ]);
    } catch (cause) {
      if (currentIdentity.current === submittedFor)
        setSaveError(errorMessage(cause));
    } finally {
      if (currentIdentity.current === submittedFor) setSaving(null);
    }
  }

  const clearNotice = useCallback(() => {
    setNotice("");
    setSaveError("");
    setSyncError("");
  }, []);

  const clearSyncError = useCallback(() => {
    setSyncError("");
  }, []);

  return {
    save,
    cancel,
    saving,
    saveError,
    syncError,
    notice,
    clearNotice,
    clearSyncError,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
