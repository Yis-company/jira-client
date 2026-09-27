use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use super::{
    cache,
    jira::WriteFailure,
    model::{FieldValue, Owner, PendingChange, RemoteFields, StoredChange},
    write_api::{self, WriteApi},
};
use crate::{AppError, Result};

pub(super) struct Store {
    pub path: PathBuf,
    pub owner: Owner,
}

impl Store {
    pub fn load(&self, id: i64) -> Result<Option<StoredChange>> {
        cache::load_change(&cache::open(&self.path)?, &self.owner, id)
    }
    pub fn list(&self) -> Result<Vec<PendingChange>> {
        cache::list_changes(&cache::open(&self.path)?, &self.owner)
    }
    pub fn remote(&self, remote: &RemoteFields) -> Result<()> {
        cache::update_remote(&mut cache::open(&self.path)?, &self.owner, remote).map(|_| ())
    }
    pub fn state(
        &self,
        record: &StoredChange,
        state: &str,
        message: Option<&str>,
        remote: Option<&FieldValue>,
        attempted: bool,
    ) -> Result<bool> {
        cache::set_change_state(
            &mut cache::open(&self.path)?,
            &self.owner,
            record,
            state,
            message,
            remote,
            attempted,
        )
    }
    pub fn finish(
        &self,
        record: &StoredChange,
        remote: &RemoteFields,
        discard: bool,
    ) -> Result<bool> {
        cache::finish_change(
            &mut cache::open(&self.path)?,
            &self.owner,
            record,
            remote,
            discard,
        )
    }
}

// The implementation checks identity and durably claims the exact queued version
// at one short dispatch barrier. It must release its identity lock before HTTP.
#[allow(async_fn_in_trait)]
pub(super) trait DispatchGuard {
    fn active(&self) -> bool;
    async fn dispatch<A: WriteApi>(
        &self,
        store: &Store,
        record: &StoredChange,
        api: &A,
    ) -> Result<Option<(StoredChange, std::result::Result<(), WriteFailure>)>>;
}

#[derive(Debug, PartialEq)]
enum Decision {
    Matches,
    Conflict,
    Send,
    Uncertain,
}

fn decision(record: &StoredChange, remote: &FieldValue) -> Decision {
    if record.change.requested.id == remote.id {
        return Decision::Matches;
    }
    if record.accepted {
        return Decision::Conflict;
    }
    match record.change.state.as_str() {
        "unknown" | "sending" => Decision::Uncertain,
        "confirming" => Decision::Conflict,
        "queued" if record.change.base.id == remote.id => Decision::Send,
        _ => Decision::Conflict,
    }
}

#[derive(Default)]
pub(super) struct Batch {
    pub auth_failed: bool,
    pub more: bool,
}

enum Step {
    Continue,
    Defer,
    Authentication,
}

fn read_failure(store: &Store, record: &StoredChange, error: &AppError) -> Result<Step> {
    let message = error.to_string();
    let state = match record.change.state.as_str() {
        "blocked" if record.accepted => "blocked",
        "confirming" if matches!(error, AppError::Forbidden | AppError::IssueUnavailable) => {
            "blocked"
        }
        "confirming" | "unknown" => record.change.state.as_str(),
        _ if matches!(
            error,
            AppError::Unauthorized
                | AppError::Forbidden
                | AppError::IssueUnavailable
                | AppError::Scope
                | AppError::InvalidChange
        ) =>
        {
            "blocked"
        }
        _ => "queued",
    };
    store.state(
        record,
        state,
        Some(&message),
        record.change.remote.as_ref(),
        record.change.attempted,
    )?;
    Ok(if matches!(error, AppError::Unauthorized) {
        Step::Authentication
    } else if matches!(
        error,
        AppError::Network | AppError::RateLimited | AppError::Jira | AppError::Metadata
    ) {
        Step::Defer
    } else {
        Step::Continue
    })
}

async fn process<A: WriteApi, G: DispatchGuard>(
    api: &A,
    guard: &G,
    store: &Store,
    record: StoredChange,
) -> Result<Step> {
    if !guard.active() {
        return Err(AppError::AccountChanged);
    }
    let remote = match write_api::remote_issue(api, &record.change.issue_id).await {
        Ok(remote) if remote.project_key == record.change.project_key => remote,
        Ok(_) => return read_failure(store, &record, &AppError::Scope),
        Err(error) => return read_failure(store, &record, &error),
    };
    let value = remote
        .field_value(&record.change.field)
        .ok_or(AppError::InvalidChange)?;
    store.remote(&remote)?;
    match decision(&record, &value) {
        Decision::Matches => {
            store.finish(&record, &remote, false)?;
            return Ok(Step::Continue);
        }
        Decision::Conflict => {
            store.state(
                &record,
                "conflict",
                Some("Jira has a different value. Review it before applying your change."),
                Some(&value),
                record.change.attempted,
            )?;
            return Ok(Step::Continue);
        }
        Decision::Uncertain => {
            store.state(&record, "unknown", Some("The previous request may have run. Accept Jira's current value or check again; it will not be resent automatically."), Some(&value), true)?;
            return Ok(Step::Continue);
        }
        Decision::Send => (),
    }
    if record.change.field == "status"
        && record.source_status_id.as_ref() != Some(&remote.status.id)
    {
        return read_failure(store, &record, &AppError::InvalidChange);
    }
    if let Err(error) = write_api::validate(api, &record, &remote).await {
        return read_failure(store, &record, &error);
    }
    let Some((sending, response)) = guard.dispatch(store, &record, api).await? else {
        return Ok(Step::Continue);
    };
    match response {
        Ok(()) => {
            store.state(
                &sending,
                "confirming",
                Some("Jira accepted the request; waiting to confirm its current value."),
                None,
                true,
            )?;
            let Some(confirming) = store.load(sending.change.id)? else {
                return Ok(Step::Continue);
            };
            if !guard.active() {
                return Err(AppError::AccountChanged);
            }
            match write_api::remote_issue(api, &confirming.change.issue_id).await {
                Ok(remote) => {
                    let value = remote
                        .field_value(&confirming.change.field)
                        .ok_or(AppError::InvalidChange)?;
                    if value.id == confirming.change.requested.id {
                        store.finish(&confirming, &remote, false)?;
                    } else {
                        store.remote(&remote)?;
                        store.state(&confirming, "conflict", Some("Jira accepted the request but now reports a different value. Review the result."), Some(&value), true)?;
                    }
                }
                Err(error) => return read_failure(store, &confirming, &error),
            }
        }
        Err(WriteFailure::Deferred) => {
            store.state(
                &sending,
                "queued",
                Some("Waiting for Jira's rate limit before checking this change again."),
                None,
                true,
            )?;
            return Ok(Step::Defer);
        }
        Err(WriteFailure::Rejected { status, message }) => {
            store.state(&sending, "blocked", Some(&message), None, true)?;
            if status == 401 {
                return Ok(Step::Authentication);
            }
        }
        Err(WriteFailure::Unknown) => {
            store.state(&sending, "unknown", Some("No definitive response from Jira. The change may have been applied; check its outcome before choosing another action."), None, true)?;
            return Ok(Step::Defer);
        }
    }
    Ok(Step::Continue)
}

pub(super) async fn drain<A: WriteApi, G: DispatchGuard>(
    api: &A,
    guard: &G,
    store: &Store,
) -> Result<Batch> {
    let mut records = store
        .list()?
        .into_iter()
        .filter(|change| matches!(change.state.as_str(), "queued" | "confirming" | "unknown"))
        .map(|change| store.load(change.id))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    records.sort_by(|a, b| {
        let priority = |r: &StoredChange| match r.change.state.as_str() {
            "queued" => 0,
            "confirming" => 1,
            _ => 2,
        };
        priority(a).cmp(&priority(b)).then_with(|| {
            if a.change.state == "unknown" {
                a.version.cmp(&b.version)
            } else {
                a.change.id.cmp(&b.change.id)
            }
        })
    });
    let start = Instant::now();
    let mut count = 0;
    for record in records {
        if count >= 10 || start.elapsed() >= Duration::from_secs(5) {
            return Ok(Batch {
                more: record.change.state != "unknown",
                auth_failed: false,
            });
        }
        // A local replacement may have happened while another operation was in flight.
        let Some(record) = store.load(record.change.id)? else {
            continue;
        };
        if !matches!(
            record.change.state.as_str(),
            "queued" | "confirming" | "unknown"
        ) {
            continue;
        }
        if record.change.state == "queued" && waits_for_earlier(store, &record.change)? {
            continue;
        }
        count += 1;
        match process(api, guard, store, record).await? {
            Step::Continue => (),
            Step::Defer => return Ok(Batch::default()),
            Step::Authentication => {
                return Ok(Batch {
                    auth_failed: true,
                    more: false,
                })
            }
        }
    }
    let more = store.list()?.iter().any(|change| {
        change.state == "queued" && matches!(waits_for_earlier(store, change), Ok(false))
    });
    Ok(Batch {
        more,
        auth_failed: false,
    })
}

fn waits_for_earlier(store: &Store, change: &PendingChange) -> Result<bool> {
    Ok(store.list()?.iter().any(|earlier| {
        earlier.issue_id == change.issue_id
            && earlier.id < change.id
            && matches!(earlier.state.as_str(), "sending" | "confirming" | "unknown")
    }))
}

pub(super) async fn resolve<A: WriteApi, G: DispatchGuard>(
    api: &A,
    guard: &G,
    store: &Store,
    id: i64,
    action: &str,
) -> Result<()> {
    let record = store.load(id)?.ok_or(AppError::InvalidChange)?;
    if !guard.active() {
        return Err(AppError::AccountChanged);
    }
    match action {
        "recheck"
            if matches!(record.change.state.as_str(), "unknown" | "confirming")
                || (record.change.state == "blocked" && !record.change.can_retry) =>
        {
            process(api, guard, store, record).await?;
        }
        "discard"
            if matches!(
                record.change.state.as_str(),
                "queued" | "blocked" | "conflict"
            ) =>
        {
            cache::discard_local(&mut cache::open(&store.path)?, &store.owner, &record)?;
        }
        "discard" if record.change.state == "unknown" => {
            let remote = write_api::remote_issue(api, &record.change.issue_id).await?;
            store.finish(&record, &remote, true)?;
        }
        "keepMine" if record.change.state == "conflict" => rebase(api, store, &record).await?,
        "retry" if record.change.state == "blocked" && record.change.can_retry => {
            rebase(api, store, &record).await?
        }
        _ => return Err(AppError::ChangeLocked),
    }
    Ok(())
}

async fn rebase<A: WriteApi>(api: &A, store: &Store, record: &StoredChange) -> Result<()> {
    let remote = write_api::remote_issue(api, &record.change.issue_id).await?;
    if remote
        .field_value(&record.change.field)
        .ok_or(AppError::InvalidChange)?
        .id
        == record.change.requested.id
    {
        store.finish(record, &remote, false)?;
    } else {
        write_api::validate(api, record, &remote).await?;
        cache::rebase_change(
            &mut cache::open(&store.path)?,
            &store.owner,
            record,
            &remote,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{jira::Api, model::*};
    use super::*;
    use serde_json::{json, Value};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    };

    fn status(id: &str) -> IssueStatus {
        IssueStatus {
            id: id.into(),
            name: format!("Status {id}"),
            category: if id == "1" { "new" } else { "indeterminate" }.into(),
        }
    }
    fn user(id: &str) -> Assignee {
        Assignee {
            id: id.into(),
            display_name: format!("User {id}"),
        }
    }
    fn options() -> IssueCapabilities {
        IssueCapabilities {
            source_status_id: "1".into(),
            transitions_captured_at: Some("2026-09-27T00:00:00Z".into()),
            assignees_captured_at: Some("2026-09-27T00:00:00Z".into()),
            can_assign: true,
            assignee_query: "".into(),
            assignees_complete: false,
            transitions: ["2", "3"]
                .map(|id| CapabilityTransition {
                    id: format!("t{id}"),
                    name: format!("Move {id}"),
                    target: status(id),
                    supported: true,
                    reason: None,
                })
                .into(),
            assignees: vec![user("1"), user("2")],
        }
    }
    struct Fixture {
        store: Store,
        guard: Guard,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "jira-outbox-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let store = Store {
                path: dir.join("test.sqlite"),
                owner: Owner {
                    site_url: "https://example.atlassian.net".into(),
                    email: "test@example.com".into(),
                },
            };
            let summary = IssueSummary {
                id: "1".into(),
                key: "CK-1".into(),
                summary: "Fixture issue".into(),
                status: status("1"),
                assignee: Some(user("1")),
                issue_type: "Task".into(),
                priority: None,
                story_points: None,
                versions: vec![],
                sprint_ids: vec![11],
                epic: None,
                updated: "2026-09-27T00:00:00Z".into(),
                off_board: false,
            };
            let detail = IssueDetail { issue:summary.clone(), description:Value::Null, fields:json!({"status":{"id":"1","name":"Status 1","statusCategory":{"key":"new"}},"assignee":{"accountId":"1","displayName":"User 1"}}).as_object().unwrap().clone(), field_names:Default::default(), comments:vec![], attachments:vec![] };
            let snapshot = Snapshot {
                workspace: CachedWorkspace {
                    reference: WorkspaceRef {
                        project_key: "CK".into(),
                        board_id: 7,
                        project_name: "Fixture".into(),
                        board_name: "Test".into(),
                        last_synced_at: "2026-09-27T00:00:00Z".into(),
                    },
                    columns: vec![],
                    sprints: vec![],
                    issue_count: 1,
                    comment_count: 0,
                },
                support: json!({}),
                issues: vec![CachedIssue {
                    summary,
                    detail,
                    rank: 0,
                }],
                memberships: vec![],
            };
            let mut db = cache::open(&store.path).unwrap();
            cache::publish(&mut db, &store.owner, &snapshot).unwrap();
            cache::save_capabilities(&mut db, &store.owner, &options(), "1").unwrap();
            Self {
                store,
                guard: Guard {
                    active: Arc::new(AtomicBool::new(true)),
                },
            }
        }
        fn enqueue(&self, request: ChangeRequest) -> i64 {
            cache::enqueue(
                &mut cache::open(&self.store.path).unwrap(),
                &self.store.owner,
                "CK",
                7,
                "1",
                request,
            )
            .unwrap()
            .unwrap()
            .id
        }
        fn status(&self) -> i64 {
            self.enqueue(ChangeRequest::Status {
                transition_id: "t2".into(),
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.store.path.parent().unwrap());
        }
    }
    struct Guard {
        active: Arc<AtomicBool>,
    }
    impl DispatchGuard for Guard {
        fn active(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }
        async fn dispatch<A: WriteApi>(
            &self,
            store: &Store,
            record: &StoredChange,
            api: &A,
        ) -> Result<Option<(StoredChange, std::result::Result<(), WriteFailure>)>> {
            if !self.active() {
                return Err(AppError::AccountChanged);
            }
            if !store.state(record, "sending", None, None, true)? {
                return Ok(None);
            }
            let sending = store
                .load(record.change.id)?
                .ok_or(AppError::InvalidChange)?;
            let response = api.send_change(&sending).await;
            Ok(Some((sending, response)))
        }
    }
    #[derive(Clone, Copy)]
    enum Outcome {
        Success,
        SuccessDifferent,
        LostApplied,
        LostUnapplied,
        Reject(u16),
        RateLimit,
    }
    struct FakeApi {
        remote: Mutex<RemoteFields>,
        outcome: Outcome,
        writes: AtomicUsize,
        fail_readback: AtomicBool,
        revoke_before: Option<Arc<AtomicBool>>,
        revoke_after: Option<Arc<AtomicBool>>,
        replace_before: Option<Store>,
        assign_on_transition: bool,
        readback_status: Option<u16>,
    }
    impl FakeApi {
        fn new(outcome: Outcome) -> Self {
            Self {
                remote: Mutex::new(RemoteFields {
                    issue_id: "1".into(),
                    key: "CK-1".into(),
                    project_key: "CK".into(),
                    status: status("1"),
                    assignee: Some(user("1")),
                    updated: "2026-09-27T00:00:00Z".into(),
                }),
                outcome,
                writes: AtomicUsize::new(0),
                fail_readback: AtomicBool::new(false),
                revoke_before: None,
                revoke_after: None,
                replace_before: None,
                assign_on_transition: false,
                readback_status: None,
            }
        }
        fn count(&self) -> usize {
            self.writes.load(Ordering::SeqCst)
        }
    }
    impl Api for FakeApi {
        async fn get(&self, path: &str, _query: &[(&str, String)]) -> Result<Value> {
            if path.ends_with("/transitions") {
                if let Some(active) = &self.revoke_before {
                    active.store(false, Ordering::SeqCst);
                }
                if let Some(store) = &self.replace_before {
                    cache::enqueue(
                        &mut cache::open(&store.path)?,
                        &store.owner,
                        "CK",
                        7,
                        "1",
                        ChangeRequest::Status {
                            transition_id: "t3".into(),
                        },
                    )?;
                }
                return Ok(json!({"transitions":[
                    {"id":"t2","name":"Move 2","to":{"id":"2","name":"Status 2","statusCategory":{"key":"indeterminate"}},"fields":{}},
                    {"id":"t3","name":"Move 3","to":{"id":"3","name":"Status 3","statusCategory":{"key":"indeterminate"}},"fields":{}}
                ]}));
            }
            if path.ends_with("/mypermissions") {
                return Ok(json!({"permissions":{"ASSIGN_ISSUES":{"havePermission":true}}}));
            }
            if path.ends_with("/user/assignable/search") {
                return Ok(json!([{"accountId":"2","displayName":"User 2","active":true}]));
            }
            if self.count() > 0 {
                if let Some(status) = self.readback_status {
                    return Err(if status == 403 {
                        AppError::Forbidden
                    } else {
                        AppError::IssueUnavailable
                    });
                }
                if self.fail_readback.load(Ordering::SeqCst) {
                    return Err(AppError::Network);
                }
            }
            let remote = self.remote.lock().unwrap();
            Ok(
                json!({"id":remote.issue_id,"key":remote.key,"fields":{"project":{"key":remote.project_key},"updated":remote.updated,
                "status":{"id":remote.status.id,"name":remote.status.name,"statusCategory":{"key":remote.status.category}},
                "assignee":remote.assignee.as_ref().map(|a|json!({"accountId":a.id,"displayName":a.display_name}))}}),
            )
        }
    }
    impl WriteApi for FakeApi {
        async fn send_change(
            &self,
            record: &StoredChange,
        ) -> std::result::Result<(), WriteFailure> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            if matches!(self.outcome, Outcome::Success | Outcome::LostApplied) {
                let mut remote = self.remote.lock().unwrap();
                if record.change.field == "status" {
                    remote.status = status(record.change.requested.id.as_deref().unwrap());
                    if self.assign_on_transition {
                        remote.assignee = Some(user("3"));
                    }
                } else {
                    remote.assignee = Some(user(record.change.requested.id.as_deref().unwrap()));
                }
                remote.updated = "2026-09-27T01:00:00Z".into();
            }
            if let Some(active) = &self.revoke_after {
                active.store(false, Ordering::SeqCst);
            }
            match self.outcome {
                Outcome::Success | Outcome::SuccessDifferent => Ok(()),
                Outcome::LostApplied | Outcome::LostUnapplied => Err(WriteFailure::Unknown),
                Outcome::Reject(status) => Err(WriteFailure::Rejected {
                    status,
                    message: "Fixture rejection".into(),
                }),
                Outcome::RateLimit => Err(WriteFailure::Deferred),
            }
        }
    }

    #[tokio::test]
    async fn successful_change_is_confirmed_in_both_summary_and_raw_fields() {
        let f = Fixture::new();
        f.status();
        let api = FakeApi::new(Outcome::Success);
        drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(api.count(), 1);
        assert!(f.store.list().unwrap().is_empty());
        let detail = cache::issue(
            &cache::open(&f.store.path).unwrap(),
            &f.store.owner,
            "CK",
            7,
            "1",
        )
        .unwrap()
        .unwrap();
        assert_eq!(detail.issue.status.id, "2");
        assert_eq!(detail.fields["status"]["id"], "2");
        assert_eq!(
            detail.fields["status"]["statusCategory"]["key"],
            "indeterminate"
        );
    }
    #[tokio::test]
    async fn lost_response_never_blindly_replays_even_when_remote_still_equals_base() {
        for outcome in [Outcome::LostApplied, Outcome::LostUnapplied] {
            let f = Fixture::new();
            f.status();
            let api = FakeApi::new(outcome);
            drain(&api, &f.guard, &f.store).await.unwrap();
            assert_eq!(f.store.list().unwrap()[0].state, "unknown");
            drain(&api, &f.guard, &f.store).await.unwrap();
            assert_eq!(api.count(), 1);
            if matches!(outcome, Outcome::LostApplied) {
                assert!(f.store.list().unwrap().is_empty());
            } else {
                assert_eq!(f.store.list().unwrap()[0].state, "unknown");
            }
        }
    }
    #[tokio::test]
    async fn failed_readback_retries_reads_only_and_restart_does_not_resend() {
        let f = Fixture::new();
        f.status();
        let api = FakeApi::new(Outcome::Success);
        api.fail_readback.store(true, Ordering::SeqCst);
        drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(f.store.list().unwrap()[0].state, "confirming");
        cache::recover_sending(&mut cache::open(&f.store.path).unwrap()).unwrap();
        api.fail_readback.store(false, Ordering::SeqCst);
        drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(api.count(), 1);
        assert!(f.store.list().unwrap().is_empty());
    }
    #[tokio::test]
    async fn accepted_write_losing_visibility_is_blocked_without_mutation_retry() {
        for code in [403, 404] {
            let f = Fixture::new();
            let id = f.status();
            let mut api = FakeApi::new(Outcome::Success);
            api.readback_status = Some(code);
            drain(&api, &f.guard, &f.store).await.unwrap();
            let pending = f.store.list().unwrap();
            assert_eq!(pending[0].state, "blocked");
            assert!(!pending[0].can_retry);
            assert!(resolve(&api, &f.guard, &f.store, id, "retry")
                .await
                .is_err());
            assert_eq!(api.count(), 1);
            api.readback_status = None;
            resolve(&api, &f.guard, &f.store, id, "recheck")
                .await
                .unwrap();
            assert!(f.store.list().unwrap().is_empty());
            assert_eq!(api.count(), 1);
        }
    }
    #[tokio::test]
    async fn accepted_blocked_recheck_failure_never_reenables_dispatch() {
        let f = Fixture::new();
        let id = f.status();
        let mut api = FakeApi::new(Outcome::Success);
        api.readback_status = Some(403);
        drain(&api, &f.guard, &f.store).await.unwrap();
        api.readback_status = None;
        api.fail_readback.store(true, Ordering::SeqCst);
        resolve(&api, &f.guard, &f.store, id, "recheck")
            .await
            .unwrap();
        assert_eq!(f.store.list().unwrap()[0].state, "blocked");
        assert!(!f.store.list().unwrap()[0].can_retry);
        api.fail_readback.store(false, Ordering::SeqCst);
        api.remote.lock().unwrap().status = status("1");
        drain(&api, &f.guard, &f.store).await.unwrap();
        resolve(&api, &f.guard, &f.store, id, "recheck")
            .await
            .unwrap();
        assert_eq!(f.store.list().unwrap()[0].state, "conflict");
        assert_eq!(api.count(), 1);
        let mut record = f.store.load(id).unwrap().unwrap();
        record.change.state = "queued".into();
        assert_eq!(decision(&record, &record.change.base), Decision::Conflict);
    }
    #[tokio::test]
    async fn successful_response_with_different_readback_remains_a_visible_conflict() {
        let f = Fixture::new();
        f.status();
        let api = FakeApi::new(Outcome::SuccessDifferent);
        drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(f.store.list().unwrap()[0].state, "conflict");
        drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(api.count(), 1);
    }
    #[tokio::test]
    async fn restart_sending_is_uncertain_not_eligible_for_replay() {
        let f = Fixture::new();
        let id = f.status();
        let record = f.store.load(id).unwrap().unwrap();
        f.store.state(&record, "sending", None, None, true).unwrap();
        cache::recover_sending(&mut cache::open(&f.store.path).unwrap()).unwrap();
        let api = FakeApi::new(Outcome::Success);
        drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(api.count(), 0);
        assert_eq!(f.store.list().unwrap()[0].state, "unknown");
    }
    #[tokio::test]
    async fn independent_assignee_proceeds_when_status_conflicts() {
        let f = Fixture::new();
        f.status();
        f.enqueue(ChangeRequest::Assignee {
            account_id: "2".into(),
        });
        let api = FakeApi::new(Outcome::Success);
        api.remote.lock().unwrap().status = status("3");
        drain(&api, &f.guard, &f.store).await.unwrap();
        let pending = f.store.list().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].field, "status");
        assert_eq!(pending[0].state, "conflict");
        assert_eq!(api.count(), 1);
    }
    #[tokio::test]
    async fn transition_side_effect_is_seen_before_queued_assignment() {
        let f = Fixture::new();
        f.status();
        f.enqueue(ChangeRequest::Assignee {
            account_id: "2".into(),
        });
        let mut api = FakeApi::new(Outcome::Success);
        api.assign_on_transition = true;
        drain(&api, &f.guard, &f.store).await.unwrap();
        let pending = f.store.list().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].field, "assignee");
        assert_eq!(pending[0].state, "conflict");
        assert_eq!(api.count(), 1);
    }
    #[tokio::test]
    async fn unresolved_earlier_request_blocks_later_issue_write_but_not_its_local_intent() {
        let f = Fixture::new();
        f.status();
        f.enqueue(ChangeRequest::Assignee {
            account_id: "2".into(),
        });
        let api = FakeApi::new(Outcome::LostUnapplied);
        drain(&api, &f.guard, &f.store).await.unwrap();
        let batch = drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(api.count(), 1);
        assert!(!batch.more);
        let changes = f.store.list().unwrap();
        assert_eq!(changes[0].state, "unknown");
        assert_eq!(changes[1].state, "queued");
    }
    #[tokio::test]
    async fn queued_replacement_during_preflight_prevents_stale_dispatch() {
        let f = Fixture::new();
        f.status();
        let mut api = FakeApi::new(Outcome::Success);
        api.replace_before = Some(Store {
            path: f.store.path.clone(),
            owner: f.store.owner.clone(),
        });
        drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(api.count(), 0);
        assert_eq!(
            f.store.list().unwrap()[0].requested.id.as_deref(),
            Some("3")
        );
    }
    #[tokio::test]
    async fn identity_revocation_before_barrier_prevents_send_after_barrier_keeps_confirmation() {
        let f = Fixture::new();
        f.status();
        let mut before = FakeApi::new(Outcome::Success);
        before.revoke_before = Some(f.guard.active.clone());
        assert!(matches!(
            drain(&before, &f.guard, &f.store).await,
            Err(AppError::AccountChanged)
        ));
        assert_eq!(before.count(), 0);
        f.guard.active.store(true, Ordering::SeqCst);
        let mut after = FakeApi::new(Outcome::Success);
        after.revoke_after = Some(f.guard.active.clone());
        assert!(matches!(
            drain(&after, &f.guard, &f.store).await,
            Err(AppError::AccountChanged)
        ));
        assert_eq!(after.count(), 1);
        assert_eq!(f.store.list().unwrap()[0].state, "confirming");
        let other = Owner {
            site_url: f.store.owner.site_url.clone(),
            email: "other@example.com".into(),
        };
        assert!(
            cache::list_changes(&cache::open(&f.store.path).unwrap(), &other)
                .unwrap()
                .is_empty()
        );
    }
    #[tokio::test]
    async fn definitive_rejections_are_blocked_and_429_is_deferred() {
        for code in [400, 401, 403, 404, 409] {
            let f = Fixture::new();
            f.status();
            let api = FakeApi::new(Outcome::Reject(code));
            let batch = drain(&api, &f.guard, &f.store).await.unwrap();
            assert_eq!(f.store.list().unwrap()[0].state, "blocked");
            assert_eq!(batch.auth_failed, code == 401);
            drain(&api, &f.guard, &f.store).await.unwrap();
            assert_eq!(api.count(), 1);
        }
        let f = Fixture::new();
        f.status();
        let api = FakeApi::new(Outcome::RateLimit);
        drain(&api, &f.guard, &f.store).await.unwrap();
        assert_eq!(f.store.list().unwrap()[0].state, "queued");
        assert_eq!(api.count(), 1);
    }
}
