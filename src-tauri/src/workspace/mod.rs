mod cache;
mod daily;
mod jira;
mod model;
mod outbox;
mod write_api;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
};

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, Notify};

use crate::{read_config, saved_connection, validate_project_key, AppError, Result, Session};
use model::{CachedWorkspace, IssueDetail, IssueFilter, IssuePage, Owner, WorkspaceRef};
use model::{ChangeEvent, ChangeRequest, IssueCapabilities, PendingChange, StoredChange};
use outbox::{DispatchGuard, Store};

static SYNC_GATE: OnceLock<Mutex<()>> = OnceLock::new();
static IDENTITY_GATE: OnceLock<Mutex<()>> = OnceLock::new();
static IDENTITY_GENERATION: AtomicU64 = AtomicU64::new(0);
static WORKER_WAKE: OnceLock<Notify> = OnceLock::new();
static RECOVERED: OnceLock<Mutex<bool>> = OnceLock::new();
static AUTH_PAUSE: std::sync::Mutex<Option<(Owner, u64)>> = std::sync::Mutex::new(None);

fn wake() -> &'static Notify {
    WORKER_WAKE.get_or_init(Notify::new)
}

struct Identity {
    app: AppHandle,
    owner: Owner,
    generation: u64,
}

impl DispatchGuard for Identity {
    fn active(&self) -> bool {
        identity_generation() == self.generation
            && saved_owner(&self.app).ok().as_ref() == Some(&self.owner)
    }
    async fn dispatch<A: write_api::WriteApi>(
        &self,
        store: &Store,
        record: &StoredChange,
        api: &A,
    ) -> Result<Option<(StoredChange, std::result::Result<(), jira::WriteFailure>)>> {
        let identity_lock = identity_gate().lock().await;
        if !self.active() {
            return Err(AppError::AccountChanged);
        }
        if !store.state(record, "sending", None, record.change.remote.as_ref(), true)? {
            return Ok(None);
        }
        let sending = store
            .load(record.change.id)?
            .ok_or(AppError::InvalidChange)?;
        let response = start_request(identity_lock, api.send_change(&sending)).await;
        Ok(Some((sending, response)))
    }
}

async fn start_request<F: std::future::Future>(
    identity_lock: tokio::sync::MutexGuard<'_, ()>,
    request: F,
) -> F::Output {
    use std::{future::poll_fn, task::Poll};
    let mut request = Box::pin(request);
    // HttpApi has no async pre-send work. Start transport before allowing revocation,
    // then release the gate during the actual network wait.
    let first = poll_fn(|cx| Poll::Ready(request.as_mut().poll(cx))).await;
    drop(identity_lock);
    match first {
        Poll::Ready(result) => result,
        Poll::Pending => request.await,
    }
}

async fn connection(app: &AppHandle) -> Result<(crate::Connection, Identity)> {
    let _identity = identity_gate().lock().await;
    let connection = saved_connection(app)?;
    let identity = Identity {
        app: app.clone(),
        owner: owner(&connection.session),
        generation: identity_generation(),
    };
    Ok((connection, identity))
}

fn emit_change(app: &AppHandle, owner: &Owner, issue_id: Option<&str>) {
    if let Ok(path) = db_path(app) {
        let revision = cache::open(&path)
            .and_then(|db| cache::revision(&db, owner, issue_id))
            .unwrap_or(0);
        let _ = app.emit(
            "workspace-changed",
            ChangeEvent {
                owner: owner.clone(),
                revision,
                issue_id: issue_id.map(str::to_owned),
            },
        );
    }
}

async fn recover(app: &AppHandle) -> Result<()> {
    let mut recovered = RECOVERED.get_or_init(|| Mutex::new(false)).lock().await;
    if !*recovered {
        let path = db_path(app)?;
        tokio::task::spawn_blocking(move || cache::recover_sending(&mut cache::open(&path)?))
            .await
            .map_err(|_| AppError::Cache)??;
        *recovered = true;
    }
    Ok(())
}

pub(super) fn start_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! { _ = interval.tick() => (), _ = wake().notified() => () }
            let _ = sync_changes(app.clone()).await;
        }
    });
}

fn paused(identity: &Identity) -> bool {
    AUTH_PAUSE.lock().ok().is_some_and(|value| {
        value.as_ref().is_some_and(|(owner, generation)| {
            owner == &identity.owner && *generation == identity.generation
        })
    })
}

async fn drain(app: &AppHandle, api: &jira::HttpApi<'_>, identity: &Identity) -> Result<()> {
    if paused(identity) {
        return Err(AppError::Unauthorized);
    }
    let store = Store {
        path: db_path(app)?,
        owner: identity.owner.clone(),
    };
    let result = outbox::drain(api, identity, &store).await;
    emit_change(app, &identity.owner, None);
    let batch = result?;
    if batch.auth_failed {
        if let Ok(mut pause) = AUTH_PAUSE.lock() {
            *pause = Some((identity.owner.clone(), identity.generation));
        }
        return Err(AppError::Unauthorized);
    }
    if batch.more {
        wake().notify_one();
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn sync_changes(app: AppHandle) -> Result<()> {
    let _remote = sync_gate().lock().await;
    recover(&app).await?;
    let owner = saved_owner(&app)?;
    let store = Store {
        path: db_path(&app)?,
        owner,
    };
    if !store
        .list()?
        .iter()
        .any(|change| matches!(change.state.as_str(), "queued" | "confirming" | "unknown"))
    {
        return Ok(());
    }
    let (connection, identity) = connection(&app).await?;
    let api = jira::HttpApi::new(&connection)?;
    drain(&app, &api, &identity).await
}

#[tauri::command]
pub(super) async fn list_changes(app: AppHandle) -> Result<Vec<PendingChange>> {
    let owner = saved_owner(&app)?;
    let path = db_path(&app)?;
    tokio::task::spawn_blocking(move || cache::list_changes(&cache::open(&path)?, &owner))
        .await
        .map_err(|_| AppError::Cache)?
}

fn validate_issue(issue_id: &str) -> Result<()> {
    if issue_id.is_empty()
        || issue_id.len() > 32
        || !issue_id.bytes().all(|value| value.is_ascii_digit())
    {
        return Err(AppError::InvalidChange);
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn enqueue_change(
    app: AppHandle,
    project_key: String,
    board_id: i64,
    issue_id: String,
    change: ChangeRequest,
    expected_owner: String,
) -> Result<Option<PendingChange>> {
    validate_key(&project_key, board_id)?;
    validate_issue(&issue_id)?;
    let _identity = identity_gate().lock().await;
    let owner = saved_owner(&app)?;
    if expected_owner != format!("{}:{}", owner.site_url, owner.email) {
        return Err(AppError::AccountChanged);
    }
    let result = cache::enqueue(
        &mut cache::open(&db_path(&app)?)?,
        &owner,
        &project_key,
        board_id,
        &issue_id,
        change,
    )?;
    emit_change(&app, &owner, Some(&issue_id));
    wake().notify_one();
    Ok(result)
}

#[tauri::command]
pub(super) async fn issue_capabilities(
    app: AppHandle,
    project_key: String,
    board_id: i64,
    issue_id: String,
    refresh: bool,
    query: String,
) -> Result<IssueCapabilities> {
    validate_key(&project_key, board_id)?;
    validate_issue(&issue_id)?;
    if query.len() > 200 {
        return Err(AppError::InvalidFilter);
    }
    let path = db_path(&app)?;
    if !refresh {
        return cache::capabilities(&cache::open(&path)?, &saved_owner(&app)?, &issue_id, &query);
    }
    let _remote = sync_gate().lock().await;
    let (connection, identity) = connection(&app).await?;
    let api = jira::HttpApi::new(&connection)?;
    let remote = write_api::remote_issue(&api, &issue_id).await?;
    if remote.project_key != project_key {
        return Err(AppError::Scope);
    }
    let capabilities = write_api::capabilities(&api, &remote, &query).await?;
    let _identity = identity_gate().lock().await;
    if !identity.active() {
        return Err(AppError::AccountChanged);
    }
    let mut db = cache::open(&path)?;
    cache::update_remote(&mut db, &identity.owner, &remote)?;
    cache::save_capabilities(&mut db, &identity.owner, &capabilities, &issue_id)?;
    emit_change(&app, &identity.owner, Some(&issue_id));
    Ok(capabilities)
}

#[tauri::command]
pub(super) async fn resolve_change(app: AppHandle, id: i64, action: String) -> Result<()> {
    if id <= 0 {
        return Err(AppError::InvalidChange);
    }
    // Discarding resolved/rejected local intent works without the credential vault.
    if action == "discard" {
        let _identity = identity_gate().lock().await;
        let owner = saved_owner(&app)?;
        let store = Store {
            path: db_path(&app)?,
            owner,
        };
        if let Some(record) = store.load(id)? {
            if matches!(
                record.change.state.as_str(),
                "queued" | "blocked" | "conflict"
            ) {
                if !cache::discard_local(&mut cache::open(&store.path)?, &store.owner, &record)? {
                    return Err(AppError::ChangeLocked);
                }
                emit_change(&app, &store.owner, Some(&record.change.issue_id));
                return Ok(());
            }
        }
    }
    let _remote = sync_gate().lock().await;
    let (connection, identity) = connection(&app).await?;
    let api = jira::HttpApi::new(&connection)?;
    let store = Store {
        path: db_path(&app)?,
        owner: identity.owner.clone(),
    };
    let result = outbox::resolve(&api, &identity, &store, id, &action).await;
    emit_change(&app, &identity.owner, None);
    if result.is_ok() {
        wake().notify_one();
    }
    result
}

fn sync_gate() -> &'static Mutex<()> {
    SYNC_GATE.get_or_init(|| Mutex::new(()))
}
pub(super) fn identity_gate() -> &'static Mutex<()> {
    IDENTITY_GATE.get_or_init(|| Mutex::new(()))
}
pub(super) fn identity_generation() -> u64 {
    IDENTITY_GENERATION.load(Ordering::SeqCst)
}
pub(super) fn bump_identity_generation() {
    IDENTITY_GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn owner(session: &Session) -> Owner {
    Owner {
        site_url: session.site_url.trim().to_ascii_lowercase(),
        email: session.email.trim().to_lowercase(),
    }
}

fn saved_owner(app: &AppHandle) -> Result<Owner> {
    Ok(owner(
        &read_config(app)?.session.ok_or(AppError::NotConnected)?,
    ))
}

fn db_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::Cache)?
        .join("cache.sqlite3"))
}

fn validate_key(project_key: &str, board_id: i64) -> Result<()> {
    validate_project_key(project_key)?;
    if board_id <= 0 {
        return Err(AppError::InvalidFilter);
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn cache_workspaces(app: AppHandle) -> Result<Vec<WorkspaceRef>> {
    let owner = saved_owner(&app)?;
    let path = db_path(&app)?;
    tokio::task::spawn_blocking(move || cache::list(&cache::open(&path)?, &owner))
        .await
        .map_err(|_| AppError::Cache)?
}

#[tauri::command]
pub(super) async fn cache_workspace(
    app: AppHandle,
    project_key: String,
    board_id: i64,
) -> Result<Option<CachedWorkspace>> {
    validate_key(&project_key, board_id)?;
    let owner = saved_owner(&app)?;
    let path = db_path(&app)?;
    tokio::task::spawn_blocking(move || {
        cache::workspace(&cache::open(&path)?, &owner, &project_key, board_id)
    })
    .await
    .map_err(|_| AppError::Cache)?
}

#[tauri::command]
pub(super) async fn cache_daily(app: AppHandle, project_key: String, board_id: i64, sprint_id: i64) -> Result<daily::DailyData> {
    validate_key(&project_key, board_id)?;
    if sprint_id <= 0 { return Err(AppError::InvalidFilter); }
    let owner = saved_owner(&app)?;
    let path = db_path(&app)?;
    tokio::task::spawn_blocking(move || daily::read(&cache::open(&path)?, &owner, &project_key, board_id, sprint_id))
        .await.map_err(|_| AppError::Cache)?
}

#[tauri::command]
pub(super) async fn cache_issues(app: AppHandle, filter: IssueFilter) -> Result<IssuePage> {
    validate_key(&filter.project_key, filter.board_id)?;
    let owner = saved_owner(&app)?;
    let path = db_path(&app)?;
    tokio::task::spawn_blocking(move || cache::issues(&cache::open(&path)?, &owner, &filter))
        .await
        .map_err(|_| AppError::Cache)?
}

#[tauri::command]
pub(super) async fn cache_issue(
    app: AppHandle,
    project_key: String,
    board_id: i64,
    issue_id: String,
) -> Result<Option<IssueDetail>> {
    validate_key(&project_key, board_id)?;
    if issue_id.is_empty() || issue_id.len() > 128 {
        return Err(AppError::InvalidFilter);
    }
    let owner = saved_owner(&app)?;
    let path = db_path(&app)?;
    tokio::task::spawn_blocking(move || {
        cache::issue(
            &cache::open(&path)?,
            &owner,
            &project_key,
            board_id,
            &issue_id,
        )
    })
    .await
    .map_err(|_| AppError::Cache)?
}

#[tauri::command]
pub(super) async fn sync_workspace(
    app: AppHandle,
    project_key: String,
    board_id: i64,
) -> Result<CachedWorkspace> {
    validate_key(&project_key, board_id)?;
    let _sync = sync_gate().lock().await;
    recover(&app).await?;
    let (connection, identity) = connection(&app).await?;
    let owner = identity.owner.clone();
    let api = jira::HttpApi::new(&connection)?;
    drain(&app, &api, &identity).await?;
    let path = db_path(&app)?;
    let previous = {
        let path = path.clone();
        let owner = owner.clone();
        let project_key = project_key.clone();
        tokio::task::spawn_blocking(move || {
            cache::previous_issues(&cache::open(&path)?, &owner, &project_key, board_id)
        })
        .await
        .map_err(|_| AppError::Cache)??
    };
    let snapshot = jira::fetch_snapshot(
        &api,
        &project_key,
        board_id,
        &previous,
        chrono::Utc::now().to_rfc3339(),
    )
    .await?;
    let workspace = snapshot.workspace.clone();
    let _identity = identity_gate().lock().await;
    if !identity.active() {
        return Err(AppError::AccountChanged);
    }
    tokio::task::spawn_blocking(move || {
        cache::publish(&mut cache::open(&path)?, &owner, &snapshot)
    })
    .await
    .map_err(|_| AppError::Cache)??;
    emit_change(&app, &identity.owner, None);
    wake().notify_one();
    Ok(workspace)
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn revocation_cannot_enter_claim_to_request_start_gap_but_network_wait_releases_gate() {
        let gate = Arc::new(Mutex::new(()));
        let claimed = Arc::new(Notify::new());
        let started = Arc::new(AtomicBool::new(false));
        let response = Arc::new(Notify::new());
        let (write_gate, write_claimed, write_started, write_response) = (
            gate.clone(),
            claimed.clone(),
            started.clone(),
            response.clone(),
        );
        let writer = tokio::spawn(async move {
            let lock = write_gate.lock().await;
            write_claimed.notify_one();
            // Deliberately widen the previously unprotected claim-to-send interval.
            tokio::task::yield_now().await;
            start_request(lock, async {
                assert!(write_gate.try_lock().is_err());
                write_started.store(true, Ordering::SeqCst);
                write_response.notified().await;
                204
            })
            .await
        });
        claimed.notified().await;
        let revocation = tokio::time::timeout(std::time::Duration::from_secs(1), gate.lock())
            .await
            .unwrap();
        assert!(started.load(Ordering::SeqCst));
        response.notify_one();
        drop(revocation);
        assert_eq!(writer.await.unwrap(), 204);
    }
}
