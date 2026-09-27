import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Cloud,
  Database,
  Layers3,
  List,
  LockKeyhole,
  LogOut,
  Menu,
  RotateCw,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type Board,
  type BoardConfig,
  bridge,
  type CreateField,
  type IssueTypeMetadata,
  type Project,
} from "./lib/bridge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Workspace } from "./components/Workspace";
import { workspace } from "./lib/workspace";
import { edits } from "./lib/edits";
import { SyncChanges } from "./components/SyncChanges";
import { ownerKey, useEditRuntime } from "./hooks/useEditRuntime";
import { useThemePreference, type ThemePreference } from "./lib/theme";

type View = "current" | "backlog" | "all" | "changes" | "settings";
type SettingsTab = "setup" | "fields" | "appearance";
type WorkspaceScope = Extract<View, "current" | "backlog" | "all">;

export default function App() {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: bridge.session,
    retry: false,
  });
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("current");
  const [workspaceScope, setWorkspaceScope] =
    useState<WorkspaceScope>("current");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("setup");
  const [projectKey, setProjectKey] = useState("");
  const [boardId, setBoardId] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [openIssueRequest, setOpenIssueRequest] = useState<{
    key: { projectKey: string; boardId: number };
    issueId: string;
  } | null>(null);
  const [theme, setTheme] = useThemePreference();

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavOpen]);

  const accountKey = session.data ? ownerKey(session.data) : "";
  const editWorkerError = useEditRuntime(session.data, accountKey);
  const pendingChanges = useQuery({
    queryKey: ["changes", accountKey],
    queryFn: edits.list,
    enabled: !!session.data,
    retry: false,
  });
  const cachedWorkspaces = useQuery({
    queryKey: ["workspace-list", accountKey],
    queryFn: workspace.list,
    enabled: !!session.data,
    retry: false,
  });
  const shouldDiscover =
    (cachedWorkspaces.isSuccess &&
      (!cachedWorkspaces.data.length || view === "settings")) ||
    cachedWorkspaces.isError;
  const projects = useQuery({
    queryKey: ["projects", accountKey],
    queryFn: bridge.projects,
    enabled: !!session.data && shouldDiscover,
    retry: false,
  });
  const boards = useQuery({
    queryKey: ["boards", accountKey, projectKey],
    queryFn: () => bridge.boards(projectKey),
    enabled: !!session.data && shouldDiscover && !!projectKey,
    retry: false,
  });
  const config = useQuery({
    queryKey: ["board-config", accountKey, boardId],
    queryFn: () => bridge.boardConfig(boardId!),
    enabled:
      !!session.data &&
      view === "settings" &&
      settingsTab === "setup" &&
      boardId !== null,
    retry: false,
  });
  const fieldMeta = useQuery({
    queryKey: ["create-meta", accountKey, projectKey],
    queryFn: () => bridge.createMetadata(projectKey),
    enabled:
      !!session.data &&
      view === "settings" &&
      settingsTab === "fields" &&
      inspecting &&
      !!projectKey,
    retry: false,
  });

  useEffect(() => {
    if (projects.data?.length && !projectKey)
      setProjectKey(projects.data[0].key);
  }, [projects.data, projectKey]);
  useEffect(() => {
    if (
      boards.data?.length &&
      !boards.data.some((board) => board.id === boardId)
    )
      setBoardId(boards.data[0].id);
  }, [boards.data, boardId]);

  function navigateToScope(scope: WorkspaceScope) {
    setWorkspaceScope(scope);
    setView(scope);
    setMobileNavOpen(false);
  }
  function openSettings(tab: SettingsTab = "setup") {
    setSettingsTab(tab);
    setView("settings");
    setMobileNavOpen(false);
  }
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await bridge.connect(siteUrl, email, token);
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setToken("");
      setBusy(false);
    }
  }
  async function disconnect() {
    setError("");
    try {
      await bridge.disconnect();
      setProjectKey("");
      setBoardId(null);
      setInspecting(false);
      setOpenIssueRequest(null);
      queryClient.clear();
      await session.refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  if (session.isPending) {
    return (
      <main className="boot">
        <div className="brand-mark">J</div>
        <span>Starting your workspace…</span>
      </main>
    );
  }
  if (session.isError) {
    return (
      <main className="connect-shell">
        <div className="brand">
          <div className="brand-mark">J</div>
          <span>Jira Client</span>
        </div>
        <section className="connect-card recovery-card">
          <h1>Unable to open saved connection</h1>
          <p>{errorMessage(session.error)}</p>
          {error && (
            <Notice error title="Could not disconnect" detail={error} />
          )}
          <div className="recovery-actions">
            <Button onClick={() => void session.refetch()}>Retry</Button>
            <Button variant="secondary" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        </section>
      </main>
    );
  }
  if (!session.data) {
    return (
      <ConnectScreen
        {...{
          siteUrl,
          setSiteUrl,
          email,
          setEmail,
          token,
          setToken,
          busy,
          error,
          connect,
        }}
      />
    );
  }

  const chosenProject = projects.data?.find(
    (project) => project.key === projectKey,
  );
  const accountHost = siteHostname(session.data.siteUrl);
  const pendingCount = pendingChanges.data?.length ?? 0;
  const workspaceVisible =
    view === "current" || view === "backlog" || view === "all";
  const viewTitle = {
    current: "Current sprint",
    backlog: "Backlog",
    all: "Downloaded issues",
    changes: "Sync changes",
    settings: "Settings",
  }[view];

  return (
    <div className="app-shell workspace-shell">
      <button
        type="button"
        className="mobile-nav-toggle"
        aria-expanded={mobileNavOpen}
        aria-controls="primary-sidebar"
        onClick={() => setMobileNavOpen((open) => !open)}
      >
        {mobileNavOpen ? <X size={17} /> : <Menu size={17} />}
        <span>{viewTitle}</span>
      </button>
      <aside
        id="primary-sidebar"
        className={
          "sidebar workspace-sidebar" + (mobileNavOpen ? " mobile-open" : "")
        }
      >
        <div className="brand">
          <div className="brand-mark">J</div>
          <span>Jira Client</span>
        </div>
        <nav
          id="primary-navigation"
          className={
            "nav-tabs workspace-nav" + (mobileNavOpen ? " mobile-open" : "")
          }
          aria-label="Workspace navigation"
        >
          <div className="nav-label">WORKSPACE</div>
          <button
            type="button"
            className={`nav-item${view === "current" ? " active" : ""}`}
            aria-current={view === "current" ? "page" : undefined}
            onClick={() => navigateToScope("current")}
          >
            <Layers3 size={16} />
            Current sprint
          </button>
          <button
            type="button"
            className={`nav-item${view === "backlog" ? " active" : ""}`}
            aria-current={view === "backlog" ? "page" : undefined}
            onClick={() => navigateToScope("backlog")}
          >
            <List size={16} />
            Backlog
          </button>
          <button
            type="button"
            className={`nav-item${view === "all" ? " active" : ""}`}
            aria-current={view === "all" ? "page" : undefined}
            onClick={() => navigateToScope("all")}
          >
            <Database size={16} />
            Downloaded issues
          </button>
          <div className="sidebar-utilities">
            <div className="nav-label">PERSONAL</div>
            <button
              type="button"
              className={"nav-item" + (view === "changes" ? " active" : "")}
              aria-current={view === "changes" ? "page" : undefined}
              onClick={() => {
                setView("changes");
                setMobileNavOpen(false);
              }}
            >
              <RotateCw size={16} />
              <span>Sync changes</span>
              {pendingCount > 0 && (
                <span className="nav-count">{pendingCount}</span>
              )}
            </button>
            <button
              type="button"
              className={`nav-item${view === "settings" ? " active" : ""}`}
              aria-current={view === "settings" ? "page" : undefined}
              onClick={() => openSettings()}
            >
              <Settings size={16} />
              Settings
            </button>
          </div>
        </nav>
        <div className="sidebar-foot">
          <div className="account-card" aria-label="Connected Jira account">
            <div className="site-avatar">
              {session.data.accountName.slice(0, 1).toUpperCase()}
            </div>
            <div className="site-info">
              <strong>{session.data.accountName}</strong>
              <span>{session.data.email}</span>
              <span>{accountHost}</span>
            </div>
          </div>
        </div>
      </aside>
      <main className="main-area">
        {(view === "settings" || view === "changes") && (
          <header className="topbar workspace-topbar">
            <div className="breadcrumbs">
              <span>Workspace</span>
              <span className="crumb-slash">/</span>
              <strong>{viewTitle}</strong>
            </div>
            <div className="top-actions">
              {view === "settings" && settingsTab !== "appearance" && (
                <button
                  className="icon-button"
                  title="Refresh project metadata"
                  aria-label="Refresh project metadata"
                  onClick={() => {
                    void projects.refetch();
                    if (projectKey) void boards.refetch();
                    if (boardId !== null && settingsTab === "setup")
                      void config.refetch();
                    if (inspecting) void fieldMeta.refetch();
                  }}
                >
                  <RotateCw size={16} />
                </button>
              )}
            </div>
          </header>
        )}
        <section className="content workspace-content">
          {error && <Notice error title="Action failed" detail={error} />}
          {projects.isError && view === "settings" && (
            <Notice
              error
              title="Could not load projects"
              detail={errorMessage(projects.error)}
            />
          )}
          {boards.isError && view === "settings" && (
            <Notice
              error
              title="Could not load boards"
              detail={errorMessage(boards.error)}
            />
          )}
          <div className="workspace-host" hidden={!workspaceVisible}>
            <Workspace
              key={accountKey}
              accountKey={accountKey}
              scope={workspaceScope}
              projectKey={projectKey}
              projects={projects.data}
              boards={boards.data}
              onProjectChange={setProjectKey}
              onShowChanges={() => setView("changes")}
              openIssueRequest={openIssueRequest}
              onIssueRequestHandled={() => setOpenIssueRequest(null)}
            />
          </div>
          {view === "settings" && (
            <div className="settings-view">
              <nav
                className="settings-tabs"
                role="tablist"
                aria-label="Settings"
              >
                {(["setup", "fields", "appearance"] as const).map((tab) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === tab}
                    className={`settings-tab${settingsTab === tab ? " active" : ""}`}
                    onClick={() => setSettingsTab(tab)}
                    key={tab}
                  >
                    {tab === "setup"
                      ? "Setup"
                      : tab === "fields"
                        ? "Field metadata"
                        : "Appearance"}
                  </button>
                ))}
              </nav>
              {settingsTab !== "appearance" && (
                <div className="controls-row settings-controls">
                  <label className="control-wrap">
                    <span>PROJECT</span>
                    <select
                      aria-label="Project"
                      value={projectKey}
                      onChange={(event) => {
                        setProjectKey(event.target.value);
                        setBoardId(null);
                        setInspecting(false);
                      }}
                      disabled={!projects.data?.length}
                    >
                      {projects.data?.map((project) => (
                        <option key={project.id} value={project.key}>
                          {project.key} — {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {settingsTab === "setup" && (
                    <label className="control-wrap">
                      <span>BOARD</span>
                      <select
                        aria-label="Board"
                        value={boardId ?? ""}
                        onChange={(event) =>
                          setBoardId(Number(event.target.value))
                        }
                        disabled={!boards.data?.length}
                      >
                        {boards.data?.map((board) => (
                          <option key={board.id} value={board.id}>
                            {board.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
              {settingsTab === "setup" && (
                <ProjectOverview
                  chosenProject={chosenProject}
                  boards={boards}
                  config={config}
                  projects={projects}
                />
              )}
              {settingsTab === "fields" && (
                <FieldInspector
                  {...{ chosenProject, fieldMeta, inspecting, setInspecting }}
                />
              )}
              {settingsTab === "appearance" && (
                <section className="settings-panel appearance-settings">
                  <h2>Appearance</h2>
                  <p>Choose how Jira Client looks on this device.</p>
                  <fieldset>
                    <legend>Theme</legend>
                    {(["light", "dark", "system"] as const).map((value) => (
                      <label key={value} className="theme-choice">
                        <input
                          type="radio"
                          name="theme"
                          value={value}
                          checked={theme === value}
                          onChange={() => setTheme(value as ThemePreference)}
                        />
                        <span>
                          {value === "system"
                            ? "System"
                            : value === "light"
                              ? "Light"
                              : "Dark"}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </section>
              )}
              <section className="settings-panel account-settings">
                <div>
                  <h2>Connected account</h2>
                  <p>{session.data.accountName}</p>
                  <p>{session.data.email}</p>
                  <p>{accountHost}</p>
                </div>
                <Button
                  variant="secondary"
                  className="secondary-button"
                  onClick={() => void disconnect()}
                >
                  <LogOut size={14} />
                  Disconnect
                </Button>
              </section>
            </div>
          )}
          {view === "changes" && (
            <SyncChanges
              accountKey={accountKey}
              workerError={editWorkerError}
              openIssue={(key, issueId) => {
                setOpenIssueRequest({ key, issueId });
                setView(workspaceScope);
              }}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function ConnectScreen(props: {
  siteUrl: string;
  setSiteUrl: (s: string) => void;
  email: string;
  setEmail: (s: string) => void;
  token: string;
  setToken: (s: string) => void;
  busy: boolean;
  error: string;
  connect: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const browser =
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  return (
    <main className="connect-shell">
      <div className="connect-top">
        <div className="brand">
          <div className="brand-mark">J</div>
          <span>Jira Client</span>
        </div>
        <span className="private-label">
          <LockKeyhole size={14} /> Private desktop pilot
        </span>
      </div>
      <div className="connect-layout">
        <div className="connect-copy">
          <div className="eyebrow">A CALMER WAY TO WORK WITH JIRA</div>
          <h1>
            Your work,
            <br />
            <em>in one place.</em>
          </h1>
          <p>
            A fast desktop workspace for your Jira projects. Your connection
            stays on this device.
          </p>
          <div className="benefit">
            <div>
              <Cloud size={17} />
            </div>
            <span>
              <b>Built around Jira Cloud</b>
              <small>
                Read project and board setup directly from your site.
              </small>
            </span>
          </div>
          <div className="benefit">
            <div>
              <LockKeyhole size={17} />
            </div>
            <span>
              <b>Your token stays private</b>
              <small>
                Stored in your operating system’s secure credential vault.
              </small>
            </span>
          </div>
          <div className="benefit">
            <div>
              <ShieldCheck size={17} />
            </div>
            <span>
              <b>Personal desktop pilot</b>
              <small>
                Connecting does not change issues or project settings.
              </small>
            </span>
          </div>
        </div>
        <section className="connect-card">
          <div className="card-title">
            <h2>Connect your Jira site</h2>
            <p>Use a standard API token for your personal account.</p>
          </div>
          {browser ? (
            <div className="browser-callout">
              <div className="callout-icon">
                <LockKeyhole size={19} />
              </div>
              <div>
                <b>Open the desktop app to connect</b>
                <p>
                  Credentials are accepted only by the native app and never by
                  this browser preview.
                </p>
              </div>
            </div>
          ) : (
            <form onSubmit={props.connect} autoComplete="off">
              <label className="field-label">
                Jira site URL
                <Input
                  required
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="your-company.atlassian.net"
                  value={props.siteUrl}
                  onChange={(e) => props.setSiteUrl(e.target.value)}
                  autoComplete="url"
                />
              </label>
              <label className="field-label">
                Account email
                <Input
                  required
                  type="email"
                  placeholder="you@company.com"
                  value={props.email}
                  onChange={(e) => props.setEmail(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="field-label">
                API token
                <Input
                  required
                  type="password"
                  placeholder="Paste a standard API token"
                  value={props.token}
                  onChange={(e) => props.setToken(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              {props.error && (
                <div role="alert" className="error-message">
                  {props.error}
                </div>
              )}
              <Button
                type="submit"
                className="primary-button"
                disabled={props.busy || !props.token.trim()}
              >
                {props.busy ? "Checking connection…" : "Connect to Jira"}
                <ArrowUpRight size={16} />
              </Button>
              <div className="form-foot">
                <LockKeyhole size={12} /> Token goes directly to the desktop
                app’s secure store
              </div>
            </form>
          )}
          <div className="token-hint">
            <span>ⓘ</span>
            <p>
              Use an API token without scopes. Scoped tokens require Atlassian’s
              gateway and are not supported by this direct desktop connection.
            </p>
          </div>
        </section>
      </div>
      <div className="connect-bottom">
        <span>
          JIRA CLIENT <b>PERSONAL PILOT</b>
        </span>
        <span>Designed for focus. Connected to your own Jira.</span>
      </div>
    </main>
  );
}

function ProjectOverview({
  chosenProject,
  boards,
  config,
  projects,
}: {
  chosenProject?: Project;
  boards: ReturnType<typeof useQuery<Board[]>>;
  config: ReturnType<typeof useQuery<BoardConfig>>;
  projects: ReturnType<typeof useQuery<Project[]>>;
}) {
  return (
    <>
      <div className="summary-grid">
        <Stat
          label="PROJECTS ACCESSIBLE"
          value={projects.data?.length.toString() ?? "—"}
          hint="Visible to your account"
          icon={<Layers3 size={17} />}
        />
        <Stat
          label="BOARDS IN PROJECT"
          value={boards.data?.length.toString() ?? "—"}
          hint="Agile boards discovered"
          icon={<Database size={17} />}
        />
        <Stat
          label="BOARD COLUMNS"
          value={config.data?.columns.length.toString() ?? "—"}
          hint={config.data ? "Workflow columns loaded" : "Select a board"}
          icon={<Layers3 size={17} />}
        />
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              {chosenProject ? `${chosenProject.key} project` : "Project setup"}
            </h2>
            <p>Connected Jira configuration, loaded on demand.</p>
          </div>
          <span className="read-only-tag">READ ONLY</span>
        </div>
        {projects.isPending ? (
          <Loading />
        ) : chosenProject ? (
          <div className="project-detail">
            <div className="project-monogram">
              {chosenProject.key.slice(0, 2)}
            </div>
            <div className="project-text">
              <strong>{chosenProject.name}</strong>
              <span>
                {chosenProject.key} <i>·</i> Jira project
              </span>
            </div>
            <div className="detail-status">
              <Check size={14} /> Available
            </div>
          </div>
        ) : (
          !projects.isError && (
            <Empty
              title="No projects found"
              detail="This account does not currently have any visible Jira projects."
            />
          )
        )}
        <div className="columns-section">
          <div className="section-label">BOARD WORKFLOW</div>
          {config.isError ? (
            <Notice
              error
              title="Could not load board workflow"
              detail={errorMessage(config.error)}
            />
          ) : config.isPending && !!boards.data?.length ? (
            <Loading />
          ) : config.data?.columns.length ? (
            <div className="column-list">
              {config.data.columns.map((column, index) => (
                <div className="column-item" key={column.name}>
                  <span className="column-order">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="column-name">{column.name}</span>
                  <span className="column-count">
                    {column.statuses.length} status
                    {column.statuses.length === 1 ? "" : "es"}
                  </span>
                  <span className="column-chip">
                    {column.statuses.slice(0, 3).join(", ")}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            !boards.isError && (
              <Empty
                title="Choose a board to inspect its workflow"
                detail="Board columns and statuses are fetched from Jira when you select a board."
              />
            )
          )}
        </div>
      </div>
      <div className="callout-strip">
        <div className="strip-icon">
          <CircleHelp size={17} />
        </div>
        <div>
          <strong>Issues outside this board are still in your project</strong>
          <p>
            The offline workspace keeps mismatched statuses visible under Other
            statuses.
          </p>
        </div>
        <ArrowDownRight size={17} />
      </div>
    </>
  );
}

function FieldInspector({
  chosenProject,
  fieldMeta,
  inspecting,
  setInspecting,
}: {
  chosenProject?: Project;
  fieldMeta: ReturnType<typeof useQuery<IssueTypeMetadata[]>>;
  inspecting: boolean;
  setInspecting: (v: boolean) => void;
}) {
  return (
    <div className="panel field-panel">
      <div className="panel-heading">
        <div>
          <h2>Issue creation fields</h2>
          <p>
            {chosenProject
              ? `Metadata available for ${chosenProject.key}.`
              : "Select a project to inspect its fields."}
          </p>
        </div>
        <Button
          variant="secondary"
          className="secondary-button"
          onClick={() =>
            inspecting ? void fieldMeta.refetch() : setInspecting(true)
          }
          disabled={!chosenProject || fieldMeta.isFetching}
        >
          <RotateCw size={14} />
          {fieldMeta.isFetching
            ? "Inspecting…"
            : inspecting
              ? "Refresh Jira metadata"
              : "Inspect Jira metadata"}
        </Button>
      </div>
      <div className="compatibility-banner">
        <div>
          <CircleHelp size={16} />
        </div>
        <span>
          <strong>Compatibility is unverified</strong>
          <small>
            Jira can expose fields with app-specific behavior. This screen
            inventories create metadata only; it does not claim every custom
            field is editable here.
          </small>
        </span>
      </div>
      {fieldMeta.isError && (
        <Notice
          error
          title="Metadata inspection failed"
          detail={errorMessage(fieldMeta.error)}
        />
      )}
      {fieldMeta.data ? (
        <>
          <div className="meta-summary">
            <div>
              <b>{fieldMeta.data.length}</b>
              <span>issue types</span>
            </div>
            <div>
              <b>
                {fieldMeta.data.reduce(
                  (sum, type) => sum + type.fields.length,
                  0,
                )}
              </b>
              <span>field definitions</span>
            </div>
            <p>Large option lists show a sample and total count.</p>
          </div>
          <div className="type-list">
            {fieldMeta.data.map((type) => (
              <IssueType
                key={type.id}
                name={type.name}
                count={type.fields.length}
              >
                <div className="field-list">
                  {type.fields.map((field) => (
                    <FieldRow key={field.id} field={field} />
                  ))}
                </div>
              </IssueType>
            ))}
          </div>
        </>
      ) : inspecting && fieldMeta.isPending ? (
        <Loading />
      ) : (
        !inspecting && (
          <Empty
            title="Inspect this project’s create metadata"
            detail="Jira field definitions are fetched only when requested. No issue contents are downloaded."
          />
        )
      )}
    </div>
  );
}
function FieldRow({ field }: { field: CreateField }) {
  return (
    <div className="field-row">
      <span>
        <b>{field.name}</b>
        <small>
          {field.id}
          {field.schemaType ? ` · ${field.schemaType}` : ""}
        </small>
      </span>
      {field.required && <i>Required</i>}
      {field.allowedValueCount > 0 && (
        <details className="field-options">
          <summary>
            {field.allowedValueCount} options · {field.allowedValues.length}{" "}
            sampled
          </summary>
          <ul>
            {field.allowedValues.map((option, index) => (
              <li key={index}>
                {option.value ?? "Unrecognized label"}
                {option.id ? ` · ID ${option.id}` : ""}
                {!option.value ? ` · keys: ${option.keys.join(", ")}` : ""}
              </li>
            ))}
          </ul>
          {field.unrecognizedValueCount > 0 && (
            <p>
              {field.unrecognizedValueCount} unrecognized option
              {field.unrecognizedValueCount === 1 ? "" : "s"}; sample keys:{" "}
              {field.unrecognizedSamples.join(" / ")}
            </p>
          )}
        </details>
      )}
    </div>
  );
}
function IssueType({
  name,
  count,
  children,
}: {
  name: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <details className="issue-type">
      <summary>
        <span className="type-title">
          {name}
          <span>{count} fields</span>
        </span>
      </summary>
      {children}
    </details>
  );
}
function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <i>{icon}</i>
      </div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}
function Loading() {
  return (
    <div className="loading-row">
      <span className="spinner" /> Loading data from Jira…
    </div>
  );
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <span>{title}</span>
      <p>{detail}</p>
    </div>
  );
}
function Notice({
  error,
  title,
  detail,
}: {
  error?: boolean;
  title: string;
  detail: string;
}) {
  return (
    <div
      className={error ? "notice error-message" : "notice"}
      role={error ? "alert" : "status"}
    >
      <b>{title}</b>
      <span>{detail}</span>
    </div>
  );
}
function errorMessage(cause: unknown) {
  return typeof cause === "string"
    ? cause
    : cause instanceof Error
      ? cause.message
      : "Jira could not complete that request. Try again.";
}
function siteHostname(siteUrl: string) {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}
