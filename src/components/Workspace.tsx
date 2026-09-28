import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Columns3,
  List,
  RefreshCw,
  Search,
  WifiOff,
} from "lucide-react";
import type { Board, Project } from "../lib/bridge";
import { edits, type PendingChange } from "../lib/edits";
import {
  type CachedWorkspace,
  type IssueFilter,
  type IssueSummary,
  type Sprint,
  workspace,
  type WorkspaceKey,
} from "../lib/workspace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { BacklogSections, type BacklogSectionData } from "./BacklogSections";
import { IssueDetailDialog } from "./IssueDetailDialog";
import { DailyPage } from "./DailyPage";
import {
  WorkspaceBoard,
  WorkspaceList,
  WorkspacePagination,
  type StatusColumn,
} from "./WorkspaceIssueViews";

const PAGE_SIZE = 100;
const EMPTY_ISSUES: IssueSummary[] = [];
const EMPTY_CHANGES: PendingChange[] = [];
const activeWorkspaceSyncs = new Map<
  string,
  Promise<Awaited<ReturnType<typeof workspace.sync>>>
>();
type Scope = "current" | "backlog" | "all" | "daily";
type PendingSlot = () => void;
let activeBacklogReads = 0;
const waitingBacklogReads: (() => void)[] = [];

function acquireBacklogSlot() {
  if (activeBacklogReads < 2) {
    activeBacklogReads += 1;
    return Promise.resolve(makeBacklogRelease());
  }
  return new Promise<PendingSlot>((resolve) => {
    waitingBacklogReads.push(() => resolve(makeBacklogRelease()));
  });
}

function makeBacklogRelease(): PendingSlot {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waitingBacklogReads.shift();
    if (next) next();
    else activeBacklogReads -= 1;
  };
}

async function readBacklogPage(filter: IssueFilter) {
  const release = await acquireBacklogSlot();
  try {
    return await workspace.issues(filter);
  } finally {
    release();
  }
}

function syncWorkspaceOnce(ownerKey: string, key: WorkspaceKey) {
  const syncKey = JSON.stringify([ownerKey, key.projectKey, key.boardId]);
  const active = activeWorkspaceSyncs.get(syncKey);
  if (active) return active;
  const request = workspace.sync(key).finally(() => {
    if (activeWorkspaceSyncs.get(syncKey) === request) {
      activeWorkspaceSyncs.delete(syncKey);
    }
  });
  activeWorkspaceSyncs.set(syncKey, request);
  return request;
}

export function Workspace({
  accountKey,
  projectKey,
  projects,
  boards,
  onProjectChange,
  openIssueRequest,
  onIssueRequestHandled,
  scope = "current",
  onShowChanges,
}: {
  accountKey: string;
  projectKey?: string;
  projects?: Project[];
  boards?: Board[];
  onProjectChange?: (projectKey: string) => void;
  openIssueRequest?: { key: WorkspaceKey; issueId: string } | null;
  onIssueRequestHandled?: () => void;
  scope?: Scope;
  onShowChanges?: () => void;
}) {
  const client = useQueryClient();
  const saved = useQuery({
    queryKey: ["workspace-list", accountKey],
    queryFn: workspace.list,
    retry: false,
  });
  const [selected, setSelected] = useState<WorkspaceKey | null>(null);
  const [pickedBoard, setPickedBoard] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"list" | "board">("list");
  const [issueId, setIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [onlineHint, setOnlineHint] = useState(
    typeof navigator === "undefined" || navigator.onLine,
  );
  const [pageState, setPageState] = useState({ identity: "", offset: 0 });
  const [backlogPageState, setBacklogPageState] = useState<{
    identity: string;
    offsets: Record<string, number>;
  }>({ identity: "", offsets: {} });
  const [expansionState, setExpansionState] = useState<{
    identity: string;
    values: Record<string, boolean>;
  }>({ identity: "", values: {} });
  const issueTrigger = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const wasOnline = useRef(onlineHint);
  const autoSyncStarted = useRef(new Map<string, number>());

  useEffect(() => {
    if (!selected && saved.data?.length) {
      const newest = [...saved.data].sort((a, b) =>
        b.lastSyncedAt.localeCompare(a.lastSyncedAt),
      )[0];
      setSelected({ projectKey: newest.projectKey, boardId: newest.boardId });
    }
  }, [saved.data, selected]);

  useEffect(() => {
    if (!openIssueRequest) return;
    setSelected(openIssueRequest.key);
    setSelectedIssueId(openIssueRequest.issueId);
    setIssueId(openIssueRequest.issueId);
    issueTrigger.current = null;
    onIssueRequestHandled?.();
  }, [onIssueRequestHandled, openIssueRequest]);

  const candidateProject = projectKey || projects?.[0]?.key || "";
  const scrumBoards = boards?.filter((board) => board.type === "scrum") ?? [];
  const candidateBoard = scrumBoards.some((board) => board.id === pickedBoard)
    ? pickedBoard
    : (scrumBoards[0]?.id ?? null);
  const key = selected;
  const workspaceIdentity = key
    ? JSON.stringify([accountKey, key.projectKey, key.boardId])
    : `${accountKey}:none`;
  const workspaceKey = useMemo(
    () =>
      key
        ? ["cached-workspace", accountKey, key.projectKey, key.boardId]
        : ["cached-workspace", accountKey, "none"],
    [accountKey, key?.projectKey, key?.boardId],
  );
  const cached = useQuery({
    queryKey: workspaceKey,
    queryFn: () => (key ? workspace.read(key) : Promise.resolve(null)),
    enabled: !!key,
    retry: false,
  });
  const current = cached.data;
  const search = query.trim();
  const pageIdentity = JSON.stringify([workspaceIdentity, scope, search]);
  const offset = pageState.identity === pageIdentity ? pageState.offset : 0;
  const setOffset = (nextOffset: number) =>
    setPageState({ identity: pageIdentity, offset: nextOffset });
  const listFilter: IssueFilter | null =
    key && scope !== "backlog" && scope !== "daily"
      ? { ...key, view: scope, search, offset, limit: PAGE_SIZE }
      : null;
  const page = useQuery({
    queryKey: ["cached-issues", accountKey, listFilter],
    queryFn: () => workspace.issues(listFilter!),
    enabled: !!listFilter && !!current,
    retry: false,
  });
  const changes = useQuery({
    queryKey: ["changes", accountKey],
    queryFn: edits.list,
    retry: false,
  });
  const changesByIssue = useMemo(() => {
    const map = new Map<string, PendingChange[]>();
    for (const change of changes.data ?? EMPTY_CHANGES) {
      const issueChanges = map.get(change.issueId) ?? [];
      issueChanges.push(change);
      map.set(change.issueId, issueChanges);
    }
    return map;
  }, [changes.data]);
  const detail = useQuery({
    queryKey: [
      "cached-issue",
      accountKey,
      key?.projectKey,
      key?.boardId,
      issueId,
    ],
    queryFn: () => workspace.issue(key!, issueId!),
    enabled: !!key && !!issueId,
    retry: false,
  });

  const refresh = useCallback(async () => {
    if (!key || !onlineHint) return false;
    setSyncing(true);
    setSyncError("");
    try {
      const result = await syncWorkspaceOnce(accountKey, key);
      client.setQueryData<CachedWorkspace>(workspaceKey, result);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["workspace-list", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issues", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issue", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-daily", accountKey] }),
        client.invalidateQueries({ queryKey: ["changes", accountKey] }),
      ]);
      return true;
    } catch (error) {
      setSyncError(errorText(error));
      return false;
    } finally {
      setSyncing(false);
    }
  }, [accountKey, client, key, onlineHint, workspaceKey]);

  const syncIdentity = key
    ? JSON.stringify([accountKey, key.projectKey, key.boardId])
    : "";
  useEffect(() => {
    if (!key || !cached.isSuccess || !onlineHint) return;
    const lastStarted = autoSyncStarted.current.get(syncIdentity);
    if (lastStarted && Date.now() - lastStarted < 5_000) return;
    autoSyncStarted.current.set(syncIdentity, Date.now());
    void refresh().then((success) => {
      if (!success) autoSyncStarted.current.delete(syncIdentity);
    });
  }, [cached.isSuccess, key, onlineHint, refresh, syncIdentity]);

  useEffect(() => {
    const online = () => setOnlineHint(true);
    const offline = () => setOnlineHint(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  useEffect(() => {
    if (onlineHint && !wasOnline.current && current) void refresh();
    wasOnline.current = onlineHint;
  }, [current, onlineHint, refresh]);

  useEffect(() => {
    if (!key || !current) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [key, current, refresh]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible" && onlineHint && current) {
        void refresh();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [current, onlineHint, refresh]);

  const futureSprints = useMemo(
    () => sortFutureSprints(current?.sprints ?? []),
    [current?.sprints],
  );
  const backlogIdentity = JSON.stringify([workspaceIdentity, scope, search]);
  const backlogOffsets =
    backlogPageState.identity === backlogIdentity
      ? backlogPageState.offsets
      : {};
  const defaultExpansion = (id: string) =>
    id === "unscheduled" ||
    (!!futureSprints.length && id === `future:${futureSprints[0].id}`);
  const expanded = (id: string) =>
    expansionState.identity === workspaceIdentity
      ? (expansionState.values[id] ?? false)
      : defaultExpansion(id);
  const sectionDescriptors = useMemo(
    () => [
      ...futureSprints.map((sprint) => ({ id: `future:${sprint.id}`, sprint })),
      { id: "unscheduled", sprint: undefined },
    ],
    [futureSprints],
  );
  const backlogQueries = useQueries({
    queries: sectionDescriptors.map(({ id, sprint }) => {
      const sectionOffset = backlogOffsets[id] ?? 0;
      const filter: IssueFilter | null = key
        ? {
            ...key,
            view: sprint ? "future" : "backlog",
            sprintId: sprint?.id ?? null,
            search,
            offset: sectionOffset,
            limit: PAGE_SIZE,
          }
        : null;
      return {
        queryKey: ["cached-issues", accountKey, filter],
        queryFn: () => readBacklogPage(filter!),
        enabled: scope === "backlog" && !!current && !!filter && expanded(id),
        retry: false,
      };
    }),
  });
  const backlogSections: BacklogSectionData[] = sectionDescriptors.map(
    ({ id, sprint }, index) => {
      const queryResult = backlogQueries[index];
      const isExpanded = expanded(id);
      return {
        id,
        title: sprint?.name ?? "Unscheduled backlog",
        sprint,
        expanded: isExpanded,
        loading: queryResult?.isPending ?? false,
        error: queryResult?.isError ? errorText(queryResult.error) : undefined,
        page: queryResult?.data,
        offset: backlogOffsets[id] ?? 0,
        onToggle: () => {
          const previous =
            expansionState.identity === workspaceIdentity
              ? expansionState.values
              : Object.fromEntries(
                  sectionDescriptors.map((item) => [
                    item.id,
                    defaultExpansion(item.id),
                  ]),
                );
          setExpansionState({
            identity: workspaceIdentity,
            values: { ...previous, [id]: !isExpanded },
          });
        },
        onRetry: () => void queryResult?.refetch(),
        onOffsetChange: (nextOffset) => {
          setBacklogPageState({
            identity: backlogIdentity,
            offsets: { ...backlogOffsets, [id]: nextOffset },
          });
        },
      };
    },
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (rootRef.current?.closest("[hidden]")) return;
      if (scope === "daily" || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest(".workspace-drag-handle")) return;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      const openDialog = document.querySelector("dialog[open]");
      if (openDialog) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#workspace-search")?.focus();
        return;
      }
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#workspace-search")?.focus();
        return;
      }
      if (event.key === "Escape" && target?.id === "workspace-search") {
        setQuery("");
        return;
      }
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        if (scope !== "backlog") {
          event.preventDefault();
          setMode((currentMode) => (currentMode === "list" ? "board" : "list"));
        }
        return;
      }
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveIssueFocus(1);
      }
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveIssueFocus(-1);
      }
    }
    function moveIssueFocus(delta: number) {
      const rows = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".workspace-content [data-issue-id]",
        ),
      ];
      if (!rows.length) return;
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = Math.max(
        0,
        Math.min(
          rows.length - 1,
          (index < 0 ? (delta > 0 ? -1 : rows.length) : index) + delta,
        ),
      );
      rows[next].focus();
      issueTrigger.current = rows[next];
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope]);

  const currentIssues = page.data?.issues ?? EMPTY_ISSUES;
  const columns = useMemo<StatusColumn[]>(() => {
    const list = current?.columns ?? [];
    return list.map((column) => ({
      ...column,
      issues: currentIssues.filter(
        (issue) =>
          !issue.offBoard && column.statusIds.includes(issue.status.id),
      ),
    }));
  }, [current?.columns, currentIssues]);
  const identity = current
    ? `${current.projectKey} · ${current.boardName}`
    : selected
      ? `${selected.projectKey} · Board ${selected.boardId}`
      : "Choose a board";
  const candidate =
    !!projects?.length &&
    scrumBoards.length > 0 &&
    !!candidateProject &&
    candidateBoard !== null;
  const pendingChanges = changes.data ?? EMPTY_CHANGES;

  const openIssue = (issue: IssueSummary, button: HTMLButtonElement) => {
    issueTrigger.current = button;
    setSelectedIssueId(issue.id);
    setIssueId(issue.id);
  };
  const closeIssue = () => {
    setIssueId(null);
    requestAnimationFrame(() => {
      if (rootRef.current?.closest("[hidden]")) return;
      if (issueTrigger.current?.isConnected) issueTrigger.current.focus();
      else
        document.querySelector<HTMLInputElement>("#workspace-search")?.focus();
    });
  };
  const showChanges = () => {
    issueTrigger.current = null;
    onShowChanges?.();
  };
  const setSearch = (value: string) => setQuery(value);
  const selectBoard = (projectKey: string, boardId: number) => {
    setSelected({ projectKey, boardId });
    setIssueId(null);
    setSelectedIssueId(null);
    setPageState({ identity: "", offset: 0 });
    setBacklogPageState({ identity: "", offsets: {} });
    setExpansionState({ identity: "", values: {} });
  };

  return (
    <section
      ref={rootRef}
      className="workspace-page"
      aria-label="Jira workspace"
    >
      <div className="workspace-heading">
        <div>
          <h1>{scopeTitle(scope)}</h1>
          <p>{contextSubtitle(scope, current?.sprints ?? [], identity)}</p>
        </div>
        <div className="workspace-context-actions">
          {saved.data && saved.data.length > 0 && (
            <label className="workspace-board-picker">
              <span className="sr-only">Saved board</span>
              <select
                value={`${key?.projectKey ?? ""}:${key?.boardId ?? ""}`}
                aria-label="Saved board"
                onChange={(event) => {
                  const [project, board] = event.target.value.split(":");
                  selectBoard(project, Number(board));
                }}
              >
                {saved.data.map((item) => (
                  <option
                    key={`${item.projectKey}:${item.boardId}`}
                    value={`${item.projectKey}:${item.boardId}`}
                  >
                    {item.projectKey} · {item.boardName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span
            className={`workspace-sync-state ${onlineHint ? "is-online" : "is-offline"}`}
          >
            <i aria-hidden="true" />
            {syncing
              ? "Syncing…"
              : !onlineHint
                ? "Offline"
                : syncError
                  ? "Showing saved data"
                  : current
                    ? `Synced ${formatRelative(current.lastSyncedAt)}`
                    : "Not downloaded"}
          </span>
          {current && (
            <Button
              type="button"
              variant="secondary"
              className="workspace-sync-button"
              onClick={() => void refresh()}
              disabled={syncing || !onlineHint}
            >
              <RefreshCw size={14} className={syncing ? "spin-icon" : ""} />
              Sync
            </Button>
          )}
          {onShowChanges && (
            <button
              type="button"
              className="workspace-changes-button"
              onClick={onShowChanges}
              aria-label={
                changes.isError
                  ? "Open Sync changes"
                  : `Open Sync changes${pendingChanges.length ? `, ${pendingChanges.length} pending` : ""}`
              }
            >
              Sync changes
              {pendingChanges.length > 0 && (
                <span className="workspace-changes-count">
                  {pendingChanges.length}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {(saved.isError || cached.isError) && (
        <div className="workspace-inline-error" role="alert">
          <AlertCircle size={15} />
          <span>
            {saved.isError ? errorText(saved.error) : errorText(cached.error)}
          </span>
          <button
            type="button"
            onClick={() =>
              void (saved.isError ? saved.refetch() : cached.refetch())
            }
          >
            Retry
          </button>
        </div>
      )}
      {syncError && (
        <p className="workspace-sync-error" role="status">
          {current ? "Refresh failed · showing saved data" : "Download failed"}.{" "}
          {syncError}
          {onlineHint && (
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          )}
        </p>
      )}

      {!current && selected && !cached.isError && (
        <div className="workspace-first-download">
          <h2>
            {syncing ? "Downloading your workspace" : "Preparing this board"}
          </h2>
          <p>
            Current sprint, backlog, future sprints, and issue details are saved
            on this device.
          </p>
          {syncing ? (
            <span className="workspace-muted">Downloading from Jira…</span>
          ) : !onlineHint ? (
            <span className="workspace-muted">
              <WifiOff size={14} /> Connect once to finish the first download.
            </span>
          ) : (
            <Button type="button" onClick={() => void refresh()}>
              Retry download
            </Button>
          )}
        </div>
      )}
      {!current && !selected && !saved.isPending && (
        <div className="workspace-first-download">
          <h2>Choose a board to download</h2>
          <p>
            Issues stay on this device for offline reading. Choose a project and
            Scrum board once to download its sprints and issues.
          </p>
          {projects?.length ? (
            <div className="workspace-board-setup">
              <label>
                Project
                <select
                  value={candidateProject}
                  onChange={(event) => {
                    setPickedBoard(null);
                    onProjectChange?.(event.target.value);
                  }}
                >
                  {projects.map((project) => (
                    <option key={project.key} value={project.key}>
                      {project.key} · {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Board
                <select
                  value={candidateBoard ?? ""}
                  onChange={(event) =>
                    setPickedBoard(Number(event.target.value))
                  }
                >
                  {scrumBoards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.name} · Scrum
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                disabled={!candidate}
                onClick={() =>
                  candidateBoard &&
                  selectBoard(candidateProject, candidateBoard)
                }
              >
                Continue
              </Button>
            </div>
          ) : (
            <p className="workspace-muted">
              {onlineHint
                ? "Loading Jira projects and Scrum boards…"
                : "Connect while online to choose a board for the first download."}
            </p>
          )}
        </div>
      )}

      {current && (
        scope === "daily" && key ? <DailyPage accountKey={accountKey} workspaceKey={key} current={current} pendingChanges={pendingChanges} onOpen={openIssue} /> :
        <>
          <div className="workspace-toolbar">
            <label className="workspace-search">
              <Search size={15} aria-hidden="true" />
              <Input
                id="workspace-search"
                type="search"
                value={query}
                placeholder="Search downloaded issues"
                aria-label="Search downloaded issues"
                onChange={(event) => setSearch(event.target.value)}
              />
              <kbd>/</kbd>
            </label>
            {scope !== "backlog" && (
              <div className="workspace-view-toggle" aria-label="Issue view">
                <button
                  type="button"
                  aria-pressed={mode === "list"}
                  onClick={() => setMode("list")}
                >
                  <List size={15} /> <span>List</span>
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "board"}
                  onClick={() => setMode("board")}
                >
                  <Columns3 size={15} /> <span>Board</span>
                </button>
              </div>
            )}
          </div>

          {syncError && (
            <span className="workspace-inline-sync-error">
              <AlertCircle size={14} /> Showing saved data · refresh failed
            </span>
          )}

          <div className="workspace-content">
            {scope === "backlog" ? (
              <BacklogSections
                sections={backlogSections}
                selectedId={selectedIssueId}
                changesByIssue={changesByIssue}
                onOpen={openIssue}
              />
            ) : page.isPending && !page.data ? (
              <p className="workspace-empty">Loading saved issues…</p>
            ) : page.isError && !page.data ? (
              <div className="workspace-inline-error" role="alert">
                <AlertCircle size={15} />
                <span>{errorText(page.error)}</span>
                <button type="button" onClick={() => void page.refetch()}>
                  Retry
                </button>
              </div>
            ) : (
              <>
                {page.isError && page.data && (
                  <div className="workspace-inline-error" role="status">
                    <AlertCircle size={15} />
                    <span>
                      Could not refresh this page. Showing saved results:{" "}
                      {errorText(page.error)}
                    </span>
                    <button type="button" onClick={() => void page.refetch()}>
                      Retry
                    </button>
                  </div>
                )}
                {currentIssues.length === 0 ? (
                  <p className="workspace-empty">
                    {offset > 0
                      ? "No issues on this page. Use Previous to return to the latest saved results."
                      : search
                        ? "No matching downloaded issues."
                        : scope === "current"
                          ? "No saved issues in the current sprint."
                          : "No saved downloaded issues."}
                  </p>
                ) : mode === "list" ? (
                  <WorkspaceList
                    accountKey={accountKey}
                    workspaceKey={key!}
                    issues={currentIssues}
                    columns={columns}
                    selectedId={selectedIssueId}
                    changesByIssue={changesByIssue}
                    onOpen={openIssue}
                  />
                ) : (
                  <WorkspaceBoard
                    accountKey={accountKey}
                    workspaceKey={key!}
                    issues={currentIssues}
                    columns={columns}
                    selectedId={selectedIssueId}
                    changesByIssue={changesByIssue}
                    onOpen={openIssue}
                  />
                )}
              </>
            )}
          </div>

          {scope !== "backlog" && page.data && (
            <WorkspacePagination
              total={page.data.total}
              offset={offset}
              loaded={currentIssues.length}
              onOffsetChange={setOffset}
            />
          )}
        </>
      )}

      {key && (
        <IssueDetailDialog
          key={`${accountKey}:${key.projectKey}:${key.boardId}:${issueId ?? "closed"}`}
          open={!!issueId}
          issue={detail.data}
          loading={detail.isPending}
          error={detail.error}
          sprints={current?.sprints ?? []}
          pendingChanges={
            issueId
              ? (changesByIssue.get(issueId) ?? EMPTY_CHANGES)
              : EMPTY_CHANGES
          }
          accountKey={accountKey}
          workspaceKey={key}
          onClose={closeIssue}
          onShowChanges={showChanges}
        />
      )}
    </section>
  );
}

function scopeTitle(scope: Scope) {
  return scope === "daily" ? "Daily" : scope === "current"
    ? "Current sprint"
    : scope === "backlog"
      ? "Backlog"
      : "Downloaded issues";
}

function contextSubtitle(scope: Scope, sprints: Sprint[], identity: string) {
  const sprint = sprints.find((item) => item.state === "active");
  if (scope === "current" && sprint) {
    const range = [
      formatShortDate(sprint.startDate),
      formatShortDate(sprint.endDate),
    ]
      .filter(Boolean)
      .join(" – ");
    return `${identity}${range ? ` · ${sprint.name} · ${range}` : ` · ${sprint.name}`}`;
  }
  return identity;
}

function sortFutureSprints(sprints: Sprint[]) {
  return sprints
    .filter((sprint) => sprint.state === "future")
    .sort((a, b) => {
      if (a.startDate && b.startDate) {
        const byStart = a.startDate.localeCompare(b.startDate);
        if (byStart) return byStart;
      } else if (a.startDate) return -1;
      else if (b.startDate) return 1;
      return a.id - b.id;
    });
}

function formatShortDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatRelative(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "saved";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - date.valueOf()) / 60_000),
  );
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : "saved";
}

function errorText(error: unknown) {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "Could not load saved Jira data.";
}
