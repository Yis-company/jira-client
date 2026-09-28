use std::{collections::HashMap, fs, path::Path, time::Duration};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use super::model::{
    CachedIssue, CachedWorkspace, IssueDetail, IssueFilter, IssuePage, IssueSummary, Owner,
    Snapshot, WorkspaceRef,
};
use crate::{AppError, Result};

#[derive(Clone)]
struct CanonicalSeed {
    board_id: i64,
    summary: IssueSummary,
    detail: IssueDetail,
    valid_time: Option<i64>,
}

fn db_error(_: impl std::fmt::Debug) -> AppError {
    AppError::Cache
}

pub(super) fn open(path: &Path) -> Result<Connection> {
    let dir = path.parent().ok_or(AppError::Cache)?;
    fs::create_dir_all(dir).map_err(db_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(db_error)?;
    }
    let mut db = Connection::open(path).map_err(db_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(db_error)?;
    }
    db.pragma_update(None, "foreign_keys", "ON")
        .map_err(db_error)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(db_error)?;
    if version > 3 {
        return Err(AppError::CacheVersion);
    }
    if version == 0 {
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let current: i64 = tx
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db_error)?;
        if current > 3 {
            return Err(AppError::CacheVersion);
        }
        if current == 0 {
            tx.execute_batch("\
            CREATE TABLE workspaces (\
                site TEXT NOT NULL, account TEXT NOT NULL, project_key TEXT NOT NULL, board_id INTEGER NOT NULL,\
                project_name TEXT NOT NULL, board_name TEXT NOT NULL, last_synced_at TEXT NOT NULL,\
                columns_json TEXT NOT NULL, sprints_json TEXT NOT NULL, support_json TEXT NOT NULL,\
                issue_count INTEGER NOT NULL, comment_count INTEGER NOT NULL,\
                PRIMARY KEY(site,account,project_key,board_id)\
            );\
            CREATE TABLE issues (\
                site TEXT NOT NULL, account TEXT NOT NULL, project_key TEXT NOT NULL, board_id INTEGER NOT NULL,\
                issue_id TEXT NOT NULL, issue_key TEXT NOT NULL, summary TEXT NOT NULL, updated TEXT NOT NULL,\
                rank INTEGER NOT NULL, summary_json TEXT NOT NULL, detail_json TEXT NOT NULL,\
                PRIMARY KEY(site,account,project_key,board_id,issue_id),\
                FOREIGN KEY(site,account,project_key,board_id) REFERENCES workspaces(site,account,project_key,board_id)\
            );\
            CREATE TABLE memberships (\
                site TEXT NOT NULL, account TEXT NOT NULL, project_key TEXT NOT NULL, board_id INTEGER NOT NULL,\
                view TEXT NOT NULL, sprint_id INTEGER NOT NULL, issue_id TEXT NOT NULL, rank INTEGER NOT NULL,\
                PRIMARY KEY(site,account,project_key,board_id,view,sprint_id,issue_id),\
                FOREIGN KEY(site,account,project_key,board_id,issue_id) REFERENCES issues(site,account,project_key,board_id,issue_id) ON DELETE CASCADE\
            );\
            CREATE INDEX issue_search ON issues(site,account,project_key,board_id,rank,issue_key);\
            CREATE INDEX membership_order ON memberships(site,account,project_key,board_id,view,sprint_id,rank);\
            PRAGMA user_version = 1;").map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
    }
    migrate_v1(&mut db)?;
    migrate_v2(&mut db)?;
    Ok(db)
}

fn migrate_v1(db: &mut Connection) -> Result<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let version: i64 = tx
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(db_error)?;
    if version > 3 {
        return Err(AppError::CacheVersion);
    }
    if version < 2 {
        tx.execute_batch("\
            CREATE TABLE canonical_issues (\
                site TEXT NOT NULL, account TEXT NOT NULL, issue_id TEXT NOT NULL, issue_key TEXT NOT NULL,\
                summary TEXT NOT NULL, status_json TEXT NOT NULL, assignee_json TEXT, updated TEXT NOT NULL,\
                revision INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0, detail_json TEXT,\
                PRIMARY KEY(site,account,issue_id)\
            );\
            CREATE TABLE changes (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, account TEXT NOT NULL,\
                issue_id TEXT NOT NULL, issue_key TEXT NOT NULL, summary TEXT NOT NULL,\
                project_key TEXT NOT NULL, board_id INTEGER NOT NULL, field TEXT NOT NULL, state TEXT NOT NULL,\
                base_json TEXT NOT NULL, requested_json TEXT NOT NULL, target_json TEXT, remote_json TEXT,\
                transition_id TEXT, source_status_id TEXT, error TEXT, attempted INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 0,\
                sequence INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, detail_json TEXT NOT NULL,\
                UNIQUE(site,account,issue_id,field,sequence)\
            );\
            CREATE INDEX changes_owner_state ON changes(site,account,state,sequence);\
            CREATE UNIQUE INDEX changes_one_unresolved_field ON changes(site,account,issue_id,field) WHERE state NOT IN ('confirmed','discarded');\
            CREATE TABLE capabilities (\
                site TEXT NOT NULL, account TEXT NOT NULL, issue_id TEXT NOT NULL, source_status_id TEXT NOT NULL,\
                transitions_json TEXT NOT NULL, transitions_at TEXT, assignees_json TEXT NOT NULL, assignees_at TEXT,\
                can_assign INTEGER NOT NULL, assignee_query TEXT NOT NULL, assignees_complete INTEGER NOT NULL,\
                PRIMARY KEY(site,account,issue_id,source_status_id,assignee_query)\
            );\
            CREATE INDEX capability_source ON capabilities(site,account,issue_id,source_status_id);"
        ).map_err(db_error)?;

        let mut statement = tx.prepare("SELECT site,account,project_key,board_id,issue_id,summary_json,detail_json FROM issues ORDER BY site,account,issue_id,board_id").map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(db_error)?;
        let mut grouped: HashMap<(String, String, String), Vec<CanonicalSeed>> = HashMap::new();
        for row in rows {
            let (site, account, _, board_id, issue_id, summary_json, detail_json) =
                row.map_err(db_error)?;
            let summary: IssueSummary = serde_json::from_str(&summary_json).map_err(db_error)?;
            let detail: IssueDetail = serde_json::from_str(&detail_json).map_err(db_error)?;
            grouped
                .entry((site, account, issue_id))
                .or_default()
                .push(CanonicalSeed {
                    board_id,
                    valid_time: parse_jira_time(&summary.updated),
                    summary,
                    detail,
                });
        }
        drop(statement);
        for ((site, account, issue_id), mut copies) in grouped {
            copies.sort_by(|a, b| {
                b.valid_time
                    .cmp(&a.valid_time)
                    .then_with(|| a.board_id.cmp(&b.board_id))
            });
            let chosen = &copies[0];
            let uncertain = copies.iter().any(|copy| copy.valid_time.is_none())
                || copies.iter().skip(1).any(|copy| {
                    copy.summary.key != chosen.summary.key
                        || copy.summary.summary != chosen.summary.summary
                        || copy.summary.updated != chosen.summary.updated
                        || copy.summary.status != chosen.summary.status
                        || copy.summary.assignee != chosen.summary.assignee
                });
            tx.execute("INSERT INTO canonical_issues(site,account,issue_id,issue_key,summary,status_json,assignee_json,updated,uncertain,detail_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![site,account,issue_id,chosen.summary.key,chosen.summary.summary,serde_json::to_string(&chosen.summary.status).map_err(db_error)?,serde_json::to_string(&chosen.summary.assignee).map_err(db_error)?,chosen.summary.updated,uncertain as i64,serde_json::to_string(&chosen.detail).map_err(db_error)?]).map_err(db_error)?;
        }
        tx.pragma_update(None, "user_version", 2)
            .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

fn migrate_v2(db: &mut Connection) -> Result<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let version: i64 = tx
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(db_error)?;
    if version > 3 {
        return Err(AppError::CacheVersion);
    }
    if version < 3 {
        tx.execute_batch(
            "ALTER TABLE capabilities ADD COLUMN can_unassign INTEGER NOT NULL DEFAULT 0;\
            ALTER TABLE capabilities ADD COLUMN can_edit_summary INTEGER NOT NULL DEFAULT 0;\
            ALTER TABLE capabilities ADD COLUMN can_edit_description INTEGER NOT NULL DEFAULT 0;\
            ALTER TABLE capabilities ADD COLUMN edit_capabilities_at TEXT;\
            ALTER TABLE changes ADD COLUMN source_sprint_id INTEGER;\
            ALTER TABLE changes ADD COLUMN target_sprint_id INTEGER;",
        )
        .map_err(db_error)?;
        super::daily::migrate(&tx)?;
        tx.pragma_update(None, "user_version", 3)
            .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

fn parse_jira_time(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
        .or_else(|| {
            chrono::DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z")
                .ok()
                .map(|time| time.timestamp_millis())
        })
}

pub(super) fn list(db: &Connection, owner: &Owner) -> Result<Vec<WorkspaceRef>> {
    let mut stmt = db.prepare("SELECT project_key,board_id,project_name,board_name,last_synced_at FROM workspaces WHERE site=?1 AND account=?2 ORDER BY last_synced_at DESC,project_key,board_id").map_err(db_error)?;
    let rows = stmt
        .query_map(params![owner.site_url, owner.email], |r| {
            Ok(WorkspaceRef {
                project_key: r.get(0)?,
                board_id: r.get(1)?,
                project_name: r.get(2)?,
                board_name: r.get(3)?,
                last_synced_at: r.get(4)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
}

pub(super) fn workspace(
    db: &Connection,
    owner: &Owner,
    project_key: &str,
    board_id: i64,
) -> Result<Option<CachedWorkspace>> {
    let row: Option<(String,String,String,String,String,i64,i64)> = db.query_row("SELECT project_name,board_name,last_synced_at,columns_json,sprints_json,issue_count,comment_count FROM workspaces WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4", params![owner.site_url,owner.email,project_key,board_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(db_error)?;
    let Some((
        project_name,
        board_name,
        last_synced_at,
        columns,
        sprints,
        issue_count,
        comment_count,
    )) = row
    else {
        return Ok(None);
    };
    Ok(Some(CachedWorkspace {
        reference: WorkspaceRef {
            project_key: project_key.into(),
            board_id,
            project_name,
            board_name,
            last_synced_at,
        },
        columns: serde_json::from_str(&columns).map_err(db_error)?,
        sprints: serde_json::from_str(&sprints).map_err(db_error)?,
        issue_count: usize::try_from(issue_count).map_err(db_error)?,
        comment_count: usize::try_from(comment_count).map_err(db_error)?,
    }))
}

pub(super) fn previous_issues(
    db: &Connection,
    owner: &Owner,
    project_key: &str,
    board_id: i64,
) -> Result<HashMap<String, CachedIssue>> {
    let mut stmt = db.prepare("SELECT issue_id,rank,summary_json,detail_json FROM issues WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4").map_err(db_error)?;
    let mut rows = stmt
        .query(params![owner.site_url, owner.email, project_key, board_id])
        .map_err(db_error)?;
    let mut previous = HashMap::new();
    while let Some(row) = rows.next().map_err(db_error)? {
        let id: String = row.get(0).map_err(db_error)?;
        let rank: i64 = row.get(1).map_err(db_error)?;
        let summary_json: String = row.get(2).map_err(db_error)?;
        let detail_json: String = row.get(3).map_err(db_error)?;
        let summary: IssueSummary = serde_json::from_str(&summary_json).map_err(db_error)?;
        let detail: IssueDetail = serde_json::from_str(&detail_json).map_err(db_error)?;
        previous.insert(
            id,
            CachedIssue {
                summary,
                detail,
                rank,
            },
        );
    }
    Ok(previous)
}

pub(super) fn issue(
    db: &Connection,
    owner: &Owner,
    project_key: &str,
    board_id: i64,
    issue_id: &str,
) -> Result<Option<IssueDetail>> {
    let detail: Option<String> = db.query_row("SELECT detail_json FROM issues WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 AND issue_id=?5", params![owner.site_url,owner.email,project_key,board_id,issue_id], |r| r.get(0)).optional().map_err(db_error)?;
    let mut detail = detail
        .map(|json| serde_json::from_str::<IssueDetail>(&json).map_err(db_error))
        .transpose()?;
    if let Some(detail) = &mut detail {
        overlay_issue(db, owner, project_key, board_id, detail)?;
    }
    if detail.is_none() {
        let pinned: Option<String> = db.query_row("SELECT detail_json FROM changes WHERE site=?1 AND account=?2 AND issue_id=?3 AND project_key=?4 AND board_id=?5 AND state NOT IN ('confirmed','discarded') ORDER BY sequence DESC LIMIT 1",params![owner.site_url,owner.email,issue_id,project_key,board_id],|row|row.get(0)).optional().map_err(db_error)?;
        detail = pinned
            .map(|json| serde_json::from_str::<IssueDetail>(&json).map_err(db_error))
            .transpose()?;
        if let Some(detail) = &mut detail {
            overlay_issue(db, owner, project_key, board_id, detail)?;
        }
    }
    Ok(detail)
}

fn overlay_issue(
    db: &Connection,
    owner: &Owner,
    project_key: &str,
    board_id: i64,
    detail: &mut IssueDetail,
) -> Result<()> {
    let canonical: Option<(String,Option<String>,String,String,Option<String>)> = db.query_row(
        "SELECT status_json,assignee_json,updated,summary,detail_json FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id=?3",
        params![owner.site_url,owner.email,detail.issue.id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
    ).optional().map_err(db_error)?;
    if let Some((status, assignee, updated, summary, canonical_detail)) = canonical {
        detail.issue.status = serde_json::from_str(&status).map_err(db_error)?;
        detail.issue.assignee = assignee
            .map(|value| serde_json::from_str(&value).map_err(db_error))
            .transpose()?
            .flatten();
        detail.issue.updated = updated;
        detail.issue.summary = summary;
        if let Some(canonical_detail) =
            canonical_detail.and_then(|json| serde_json::from_str::<IssueDetail>(&json).ok())
        {
            detail.description = canonical_detail.description.clone();
            for field in ["summary", "description"] {
                if let Some(value) = canonical_detail.fields.get(field) {
                    detail.fields.insert(field.into(), value.clone());
                }
            }
        }
    }
    let pending: Vec<(String, String, Option<String>, String, i64)> = {
        let mut stmt = db.prepare("SELECT field,requested_json,target_json,project_key,board_id FROM changes WHERE site=?1 AND account=?2 AND issue_id=?3 AND state NOT IN ('confirmed','discarded') ORDER BY sequence DESC").map_err(db_error)?;
        let rows = stmt
            .query_map(
                params![owner.site_url, owner.email, detail.issue.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?
    };
    let mut status_override = None;
    let mut assignee_override = None;
    let mut summary_override = None;
    let mut description_override = None;
    let mut sprint_source_removals = Vec::new();
    let mut sprint_target_additions = Vec::new();
    for (field, requested, target, change_project, change_board) in pending {
        if field == "status" && status_override.is_none() {
            status_override = target
                .map(|value| {
                    serde_json::from_str::<super::model::IssueStatus>(&value).map_err(db_error)
                })
                .transpose()?;
        } else if field == "assignee" && assignee_override.is_none() {
            let value: super::model::FieldValue =
                serde_json::from_str(&requested).map_err(db_error)?;
            assignee_override = Some(value.id.map(|id| super::model::Assignee {
                id,
                display_name: value.label,
            }));
        } else if field == "summary" && summary_override.is_none() {
            summary_override = serde_json::from_str::<super::model::FieldValue>(&requested)
                .ok()
                .and_then(|value| value.value)
                .and_then(|value| value.as_str().map(str::to_owned));
        } else if field == "description" && description_override.is_none() {
            description_override = serde_json::from_str::<super::model::FieldValue>(&requested)
                .ok()
                .and_then(|value| value.value);
        } else if field == "sprint" {
            if let Some(value) = serde_json::from_str::<super::model::FieldValue>(&requested)
                .ok()
                .and_then(|field| field.value)
            {
                if let Some(source) = value.get("sourceSprintId").and_then(Value::as_i64) {
                    sprint_source_removals.push(source);
                }
                if change_project == project_key && change_board == board_id {
                    if let Some(target) = value.get("targetSprintId").and_then(Value::as_i64) {
                        sprint_target_additions.push(target);
                    }
                }
            }
        }
    }
    if let Some(status) = status_override {
        detail.issue.status = status;
    }
    if let Some(assignee) = assignee_override {
        detail.issue.assignee = assignee;
    }
    if let Some(summary) = summary_override {
        detail.issue.summary = summary;
        detail.fields.insert(
            "summary".into(),
            Value::String(detail.issue.summary.clone()),
        );
    }
    if let Some(description) = description_override {
        detail.description = description.clone();
        detail.fields.insert("description".into(), description);
    }
    for source in sprint_source_removals {
        detail.issue.sprint_ids.retain(|id| *id != source);
    }
    if let Some(target) = sprint_target_additions.first().copied() {
        if !detail.issue.sprint_ids.contains(&target) {
            detail.issue.sprint_ids.push(target);
        }
    }
    let status_raw = raw_status(detail.fields.get("status"), &detail.issue.status);
    let assignee_raw = raw_assignee(
        detail.fields.get("assignee"),
        detail.issue.assignee.as_ref(),
    );
    detail.fields.insert("status".into(), status_raw);
    detail.fields.insert("assignee".into(), assignee_raw);
    Ok(())
}

fn raw_status(existing: Option<&Value>, status: &super::model::IssueStatus) -> Value {
    let mut raw = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    raw.insert("id".into(), Value::String(status.id.clone()));
    raw.insert("name".into(), Value::String(status.name.clone()));
    let mut category = raw
        .get("statusCategory")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    category.insert("key".into(), Value::String(status.category.clone()));
    raw.insert("statusCategory".into(), Value::Object(category));
    Value::Object(raw)
}

fn raw_assignee(existing: Option<&Value>, assignee: Option<&super::model::Assignee>) -> Value {
    let Some(assignee) = assignee else {
        return Value::Null;
    };
    let mut raw = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    raw.insert("accountId".into(), Value::String(assignee.id.clone()));
    raw.insert(
        "displayName".into(),
        Value::String(assignee.display_name.clone()),
    );
    Value::Object(raw)
}

pub(super) fn issues(db: &Connection, owner: &Owner, filter: &IssueFilter) -> Result<IssuePage> {
    if filter.offset < 0
        || !(1..=200).contains(&filter.limit)
        || !matches!(
            filter.view.as_str(),
            "current" | "backlog" | "future" | "all"
        )
        || filter.sprint_id.is_some_and(|id| id <= 0)
    {
        return Err(AppError::InvalidFilter);
    }
    let search = format!(
        "%{}%",
        filter
            .search
            .trim()
            .chars()
            .flat_map(|ch| match ch {
                '%' | '_' | '\\' => vec!['\\', ch],
                other => vec![other],
            })
            .collect::<String>()
    );
    let sprint_id = filter.sprint_id.unwrap_or(0);
    // Pending edits participate before count/search/pagination so the list and
    // its total reflect the same projection that overlay_summary returns.
    let where_sql = concat!(
        "i.site=?1 AND i.account=?2 AND i.project_key=?3 AND i.board_id=?4 AND ",
        "(i.issue_key LIKE ?5 ESCAPE '\\' OR COALESCE((",
        "SELECT json_extract(c.requested_json,'$.value') FROM changes c ",
        "WHERE c.site=i.site AND c.account=i.account AND c.issue_id=i.issue_id ",
        "AND c.field='summary' AND c.state NOT IN ('confirmed','discarded') ",
        "ORDER BY c.sequence DESC LIMIT 1),(",
        "SELECT ci.summary FROM canonical_issues ci WHERE ci.site=i.site ",
        "AND ci.account=i.account AND ci.issue_id=i.issue_id),i.summary) ",
        "LIKE ?5 ESCAPE '\\') AND (?6='all' OR ",
        "EXISTS(SELECT 1 FROM memberships m WHERE m.site=i.site AND m.account=i.account ",
        "AND m.project_key=i.project_key AND m.board_id=i.board_id AND m.issue_id=i.issue_id ",
        "AND m.view=?6 AND m.sprint_id=?7 AND NOT (?6='current' AND EXISTS(",
        "SELECT 1 FROM changes c WHERE c.site=i.site AND c.account=i.account ",
        "AND c.issue_id=i.issue_id AND c.field='sprint' AND (?7=0 OR c.source_sprint_id=?7) ",
        "AND c.state NOT IN ('confirmed','discarded')))) OR (?6='future' AND EXISTS(",
        "SELECT 1 FROM changes c WHERE c.site=i.site AND c.account=i.account ",
        "AND c.project_key=i.project_key AND c.board_id=i.board_id AND c.issue_id=i.issue_id ",
        "AND c.field='sprint' AND c.target_sprint_id=?7 ",
        "AND c.state NOT IN ('confirmed','discarded'))))"
    );
    let tx = db.unchecked_transaction().map_err(db_error)?;
    let total: i64 = tx
        .query_row(
            &format!("SELECT COUNT(*) FROM issues i WHERE {where_sql}"),
            params![
                owner.site_url,
                owner.email,
                filter.project_key,
                filter.board_id,
                search,
                filter.view,
                sprint_id
            ],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    let sql = format!("SELECT i.summary_json FROM issues i WHERE {where_sql} ORDER BY CASE WHEN ?6='all' THEN i.rank ELSE COALESCE((SELECT m.rank FROM memberships m WHERE m.site=i.site AND m.account=i.account AND m.project_key=i.project_key AND m.board_id=i.board_id AND m.issue_id=i.issue_id AND m.view=?6 AND m.sprint_id=?7),i.rank) END,i.issue_key,i.issue_id LIMIT ?8 OFFSET ?9");
    let mut stmt = tx.prepare(&sql).map_err(db_error)?;
    let rows = stmt
        .query_map(
            params![
                owner.site_url,
                owner.email,
                filter.project_key,
                filter.board_id,
                search,
                filter.view,
                sprint_id,
                filter.limit,
                filter.offset
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(db_error)?;
    let mut issues = Vec::new();
    for row in rows {
        let mut issue: IssueSummary =
            serde_json::from_str(&row.map_err(db_error)?).map_err(db_error)?;
        overlay_summary(&tx, owner, &filter.project_key, filter.board_id, &mut issue)?;
        issues.push(issue);
    }
    drop(stmt);
    tx.commit().map_err(db_error)?;
    Ok(IssuePage { issues, total })
}

fn overlay_summary(
    db: &Connection,
    owner: &Owner,
    project_key: &str,
    board_id: i64,
    issue: &mut IssueSummary,
) -> Result<()> {
    let remote: Option<(String,Option<String>,String,String)> = db.query_row(
        "SELECT status_json,assignee_json,updated,summary FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id=?3",
        params![owner.site_url,owner.email,issue.id],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(db_error)?;
    if let Some((status, assignee, updated, summary)) = remote {
        issue.status = serde_json::from_str(&status).map_err(db_error)?;
        issue.assignee = assignee
            .map(|value| serde_json::from_str(&value).map_err(db_error))
            .transpose()?
            .flatten();
        issue.updated = updated;
        issue.summary = summary;
    }
    let mut stmt = db.prepare("SELECT field,requested_json,target_json,project_key,board_id FROM changes WHERE site=?1 AND account=?2 AND issue_id=?3 AND state NOT IN ('confirmed','discarded') ORDER BY sequence DESC").map_err(db_error)?;
    let rows = stmt
        .query_map(params![owner.site_url, owner.email, issue.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(db_error)?;
    let mut has_status = false;
    let mut has_assignee = false;
    let mut has_summary = false;
    for row in rows {
        let (field, requested, target, change_project, change_board) = row.map_err(db_error)?;
        if field == "status" && !has_status {
            if let Some(target) = target {
                issue.status = serde_json::from_str(&target).map_err(db_error)?;
            }
            has_status = true;
        } else if field == "assignee" && !has_assignee {
            let value: super::model::FieldValue =
                serde_json::from_str(&requested).map_err(db_error)?;
            issue.assignee = value.id.map(|id| super::model::Assignee {
                id,
                display_name: value.label,
            });
            has_assignee = true;
        } else if field == "summary" && !has_summary {
            if let Ok(value) = serde_json::from_str::<super::model::FieldValue>(&requested) {
                if let Some(summary) = value
                    .value
                    .and_then(|value| value.as_str().map(str::to_owned))
                {
                    issue.summary = summary;
                    has_summary = true;
                }
            }
        } else if field == "sprint" {
            if let Ok(value) = serde_json::from_str::<super::model::FieldValue>(&requested) {
                if let Some(value) = value.value {
                    if let Some(source) = value.get("sourceSprintId").and_then(Value::as_i64) {
                        issue.sprint_ids.retain(|id| *id != source);
                    }
                    if change_project == project_key && change_board == board_id {
                        if let Some(target) = value.get("targetSprintId").and_then(Value::as_i64) {
                            if !issue.sprint_ids.contains(&target) {
                                issue.sprint_ids.push(target);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

pub(super) fn publish(db: &mut Connection, owner: &Owner, snapshot: &Snapshot) -> Result<()> {
    let key = &snapshot.workspace.reference;
    let tx = db.transaction().map_err(db_error)?;
    tx.execute("INSERT INTO workspaces(site,account,project_key,board_id,project_name,board_name,last_synced_at,columns_json,sprints_json,support_json,issue_count,comment_count) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(site,account,project_key,board_id) DO UPDATE SET project_name=excluded.project_name,board_name=excluded.board_name,last_synced_at=excluded.last_synced_at,columns_json=excluded.columns_json,sprints_json=excluded.sprints_json,support_json=excluded.support_json,issue_count=excluded.issue_count,comment_count=excluded.comment_count", params![owner.site_url,owner.email,key.project_key,key.board_id,key.project_name,key.board_name,key.last_synced_at,serde_json::to_string(&snapshot.workspace.columns).map_err(db_error)?,serde_json::to_string(&snapshot.workspace.sprints).map_err(db_error)?,serde_json::to_string(&snapshot.support).map_err(db_error)?,snapshot.workspace.issue_count as i64,snapshot.workspace.comment_count as i64]).map_err(db_error)?;
    tx.execute(
        "DELETE FROM memberships WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4",
        params![owner.site_url, owner.email, key.project_key, key.board_id],
    )
    .map_err(db_error)?;
    for issue in &snapshot.issues {
        reconcile_canonical(&tx, owner, &issue.summary, &issue.detail)?;
    }
    tx.execute(
        "DELETE FROM issues WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4",
        params![owner.site_url, owner.email, key.project_key, key.board_id],
    )
    .map_err(db_error)?;
    {
        let mut insert = tx.prepare("INSERT INTO issues(site,account,project_key,board_id,issue_id,issue_key,summary,updated,rank,summary_json,detail_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)").map_err(db_error)?;
        for issue in &snapshot.issues {
            insert
                .execute(params![
                    owner.site_url,
                    owner.email,
                    key.project_key,
                    key.board_id,
                    issue.summary.id,
                    issue.summary.key,
                    issue.summary.summary,
                    issue.summary.updated,
                    issue.rank,
                    serde_json::to_string(&issue.summary).map_err(db_error)?,
                    serde_json::to_string(&issue.detail).map_err(db_error)?
                ])
                .map_err(db_error)?;
        }
    }
    {
        let mut insert = tx.prepare("INSERT INTO memberships(site,account,project_key,board_id,view,sprint_id,issue_id,rank) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)").map_err(db_error)?;
        for member in &snapshot.memberships {
            insert
                .execute(params![
                    owner.site_url,
                    owner.email,
                    key.project_key,
                    key.board_id,
                    member.view,
                    member.sprint_id,
                    member.issue_id,
                    member.rank
                ])
                .map_err(db_error)?;
        }
    }
    super::daily::capture(&tx, owner, snapshot)?;
    tx.commit().map_err(db_error)
}

fn reconcile_canonical(
    db: &Connection,
    owner: &Owner,
    summary: &IssueSummary,
    detail: &IssueDetail,
) -> Result<()> {
    let existing: Option<(String,String,String,Option<String>,String,i64)> = db.query_row(
        "SELECT issue_key,summary,status_json,assignee_json,updated,uncertain FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id=?3",
        params![owner.site_url,owner.email,summary.id],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    ).optional().map_err(db_error)?;
    let status = serde_json::to_string(&summary.status).map_err(db_error)?;
    let assignee = serde_json::to_string(&summary.assignee).map_err(db_error)?;
    let detail_json = serde_json::to_string(detail).map_err(db_error)?;
    let incoming_time = parse_jira_time(&summary.updated);
    let Some((_, _, old_status, old_assignee, old_updated, old_uncertain)) = existing else {
        db.execute("INSERT INTO canonical_issues(site,account,issue_id,issue_key,summary,status_json,assignee_json,updated,uncertain,detail_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![owner.site_url,owner.email,summary.id,summary.key,summary.summary,status,assignee,summary.updated,incoming_time.is_none() as i64,detail_json]).map_err(db_error)?;
        return Ok(());
    };
    let old_time = parse_jira_time(&old_updated);
    if incoming_time.is_none() || old_time.is_none() {
        db.execute(
            "UPDATE canonical_issues SET uncertain=1 WHERE site=?1 AND account=?2 AND issue_id=?3",
            params![owner.site_url, owner.email, summary.id],
        )
        .map_err(db_error)?;
    } else if incoming_time > old_time {
        db.execute("UPDATE canonical_issues SET issue_key=?4,summary=?5,status_json=?6,assignee_json=?7,updated=?8,detail_json=?9,uncertain=0 WHERE site=?1 AND account=?2 AND issue_id=?3",params![owner.site_url,owner.email,summary.id,summary.key,summary.summary,status,assignee,summary.updated,detail_json]).map_err(db_error)?;
    } else if incoming_time == old_time
        && (old_status != status || old_assignee.as_deref() != Some(assignee.as_str()))
    {
        db.execute(
            "UPDATE canonical_issues SET uncertain=1 WHERE site=?1 AND account=?2 AND issue_id=?3",
            params![owner.site_url, owner.email, summary.id],
        )
        .map_err(db_error)?;
    } else if old_uncertain != 0 {
        // A same-revision snapshot cannot resolve a conflicting baseline.
    }
    Ok(())
}

pub(super) fn capabilities(
    db: &Connection,
    owner: &Owner,
    issue_id: &str,
    query: &str,
) -> Result<super::model::IssueCapabilities> {
    let result: Option<super::model::IssueCapabilities> = db.query_row(
        "SELECT source_status_id,transitions_json,transitions_at,assignees_json,assignees_at,can_assign,assignee_query,assignees_complete,can_unassign,can_edit_summary,can_edit_description,edit_capabilities_at FROM capabilities WHERE site=?1 AND account=?2 AND issue_id=?3 AND assignee_query=?4 ORDER BY transitions_at DESC LIMIT 1",
        params![owner.site_url,owner.email,issue_id,query],
        |row| {
            let transitions:String=row.get(1)?; let assignees:String=row.get(3)?;
            Ok(super::model::IssueCapabilities { source_status_id:row.get(0)?, transitions:serde_json::from_str(&transitions).map_err(|_|rusqlite::Error::InvalidQuery)?, transitions_captured_at:row.get(2)?, assignees:serde_json::from_str(&assignees).map_err(|_|rusqlite::Error::InvalidQuery)?, assignees_captured_at:row.get(4)?, can_assign:row.get::<_,i64>(5)? != 0, assignee_query:row.get(6)?, assignees_complete:row.get::<_,i64>(7)? != 0, can_unassign:row.get::<_,i64>(8)? != 0, can_edit_summary:row.get::<_,i64>(9)? != 0, can_edit_description:row.get::<_,i64>(10)? != 0, edit_capabilities_at:row.get(11)? })
        }
    ).optional().map_err(db_error)?;
    if let Some(result) = result {
        return Ok(result);
    }
    let source_status_id = db
        .query_row(
            "SELECT status_json FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id=?3",
            params![owner.site_url, owner.email, issue_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
        .and_then(|json| {
            serde_json::from_str::<super::model::IssueStatus>(&json)
                .ok()
                .map(|status| status.id)
        })
        .unwrap_or_default();
    Ok(super::model::IssueCapabilities {
        source_status_id,
        transitions_captured_at: None,
        assignees_captured_at: None,
        transitions: vec![],
        assignees: vec![],
        can_assign: false,
        can_unassign: false,
        can_edit_summary: false,
        can_edit_description: false,
        edit_capabilities_at: None,
        assignee_query: query.into(),
        assignees_complete: false,
    })
}

pub(super) fn save_capabilities(
    db: &mut Connection,
    owner: &Owner,
    caps: &super::model::IssueCapabilities,
    issue_id: &str,
) -> Result<()> {
    db.execute("INSERT INTO capabilities(site,account,issue_id,source_status_id,transitions_json,transitions_at,assignees_json,assignees_at,can_assign,assignee_query,assignees_complete,can_unassign,can_edit_summary,can_edit_description,edit_capabilities_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) ON CONFLICT(site,account,issue_id,source_status_id,assignee_query) DO UPDATE SET transitions_json=excluded.transitions_json,transitions_at=excluded.transitions_at,assignees_json=excluded.assignees_json,assignees_at=excluded.assignees_at,can_assign=excluded.can_assign,assignees_complete=excluded.assignees_complete,can_unassign=excluded.can_unassign,can_edit_summary=excluded.can_edit_summary,can_edit_description=excluded.can_edit_description,edit_capabilities_at=excluded.edit_capabilities_at",params![owner.site_url,owner.email,issue_id,caps.source_status_id,serde_json::to_string(&caps.transitions).map_err(db_error)?,caps.transitions_captured_at,serde_json::to_string(&caps.assignees).map_err(db_error)?,caps.assignees_captured_at,caps.can_assign as i64,caps.assignee_query,caps.assignees_complete as i64,caps.can_unassign as i64,caps.can_edit_summary as i64,caps.can_edit_description as i64,caps.edit_capabilities_at]).map_err(db_error)?;
    Ok(())
}

fn pending_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<super::model::PendingChange> {
    let base: String = row.get(9)?;
    let requested: String = row.get(10)?;
    let remote: Option<String> = row.get(11)?;
    Ok(super::model::PendingChange {
        id: row.get(0)?,
        issue_id: row.get(1)?,
        issue_key: row.get(2)?,
        summary: row.get(3)?,
        project_key: row.get(4)?,
        board_id: row.get(5)?,
        field: row.get(6)?,
        state: row.get(7)?,
        attempted: row.get::<_, i64>(8)? != 0,
        can_retry: row.get::<_, i64>(14)? == 0 && row.get::<_, String>(7)? == "blocked",
        base: serde_json::from_str(&base).map_err(|_| rusqlite::Error::InvalidQuery)?,
        requested: serde_json::from_str(&requested).map_err(|_| rusqlite::Error::InvalidQuery)?,
        remote: remote
            .map(|value| serde_json::from_str(&value).map_err(|_| rusqlite::Error::InvalidQuery))
            .transpose()?,
        error: row.get(12)?,
        created_at: row.get(13)?,
    })
}

pub(super) fn list_changes(
    db: &Connection,
    owner: &Owner,
) -> Result<Vec<super::model::PendingChange>> {
    let mut stmt=db.prepare("SELECT id,issue_id,issue_key,summary,project_key,board_id,field,state,attempted,base_json,requested_json,remote_json,error,created_at,accepted FROM changes WHERE site=?1 AND account=?2 AND state NOT IN ('confirmed','discarded') ORDER BY sequence").map_err(db_error)?;
    let rows = stmt
        .query_map(params![owner.site_url, owner.email], pending_from_row)
        .map_err(db_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
}

pub(super) fn enqueue(
    db: &mut Connection,
    owner: &Owner,
    project_key: &str,
    board_id: i64,
    issue_id: &str,
    request: super::model::ChangeRequest,
) -> Result<Option<super::model::PendingChange>> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let canonical:Option<(String,String,String,Option<String>,String,i64,Option<String>)>=tx.query_row("SELECT issue_key,summary,status_json,assignee_json,updated,uncertain,detail_json FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id=?3",params![owner.site_url,owner.email,issue_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional().map_err(db_error)?;
    let (issue_key, summary, status_json, assignee_json, updated, uncertain, canonical_detail) =
        canonical.ok_or(AppError::NotConnected)?;
    if uncertain != 0 {
        return Err(AppError::UncertainBaseline);
    }
    let status: super::model::IssueStatus = serde_json::from_str(&status_json).map_err(db_error)?;
    let assignee = assignee_json
        .map(|value| {
            serde_json::from_str::<Option<super::model::Assignee>>(&value).map_err(db_error)
        })
        .transpose()?
        .flatten();
    let board_detail: Option<String> = tx.query_row("SELECT detail_json FROM issues WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 AND issue_id=?5", params![owner.site_url,owner.email,project_key,board_id,issue_id], |row| row.get(0)).optional().map_err(db_error)?;
    let pinned_detail: Option<String> = tx.query_row("SELECT detail_json FROM changes WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 AND issue_id=?5 AND state NOT IN ('confirmed','discarded') ORDER BY sequence DESC LIMIT 1", params![owner.site_url,owner.email,project_key,board_id,issue_id], |row| row.get(0)).optional().map_err(db_error)?;
    let detail = board_detail
        .or(pinned_detail)
        .as_deref()
        .map(serde_json::from_str::<IssueDetail>)
        .transpose()
        .map_err(db_error)?;
    let field = match &request {
        super::model::ChangeRequest::Status { .. } => "status",
        super::model::ChangeRequest::Assignee { .. } => "assignee",
        super::model::ChangeRequest::Summary { .. } => "summary",
        super::model::ChangeRequest::Description { .. } => "description",
        super::model::ChangeRequest::Sprint { .. } => "sprint",
    };
    let existing:Option<(i64,String,String,String,String,Option<String>,i64,String)>=tx.query_row("SELECT id,base_json,requested_json,field,state,transition_id,attempted,detail_json FROM changes WHERE site=?1 AND account=?2 AND issue_id=?3 AND field=?4 AND state NOT IN ('confirmed','discarded') ORDER BY sequence DESC LIMIT 1",params![owner.site_url,owner.email,issue_id,field],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?))).optional().map_err(db_error)?;
    let base = match field {
        "status" => super::model::FieldValue {
            id: Some(status.id.clone()),
            label: status.name.clone(),
            value: None,
        },
        "assignee" => super::model::FieldValue {
            id: assignee.as_ref().map(|value| value.id.clone()),
            label: assignee
                .as_ref()
                .map(|value| value.display_name.clone())
                .unwrap_or_else(|| "Unassigned".into()),
            value: None,
        },
        "summary" => super::model::FieldValue {
            id: None,
            label: summary.clone(),
            value: Some(Value::String(summary.clone())),
        },
        "description" => {
            let value = canonical_detail
                .as_deref()
                .map(serde_json::from_str::<IssueDetail>)
                .transpose()
                .map_err(db_error)?
                .and_then(|detail| detail.fields.get("description").cloned())
                .unwrap_or(Value::Null);
            super::model::FieldValue {
                id: None,
                label: "Description".into(),
                value: Some(value),
            }
        }
        "sprint" => {
            let issue = detail.as_ref().ok_or(AppError::NotConnected)?.issue.clone();
            super::model::FieldValue {
                id: None,
                label: issue
                    .sprint_ids
                    .iter()
                    .map(i64::to_string)
                    .collect::<Vec<_>>()
                    .join(", "),
                value: Some(serde_json::json!({"sprintIds": issue.sprint_ids})),
            }
        }
        _ => return Err(AppError::InvalidChange),
    };
    let (requested, target, transition_id, source_status_id, source_sprint_id, target_sprint_id) =
        match request {
            super::model::ChangeRequest::Status { transition_id } => {
                let mut transitions: Vec<super::model::CapabilityTransition> = vec![];
                let mut stmt=tx.prepare("SELECT transitions_json FROM capabilities WHERE site=?1 AND account=?2 AND issue_id=?3 AND source_status_id=?4").map_err(db_error)?;
                let rows = stmt
                    .query_map(
                        params![owner.site_url, owner.email, issue_id, status.id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(db_error)?;
                for row in rows {
                    transitions.extend(
                        serde_json::from_str::<Vec<super::model::CapabilityTransition>>(
                            &row.map_err(db_error)?,
                        )
                        .map_err(db_error)?,
                    );
                }
                let transition = transitions
                    .into_iter()
                    .find(|value| value.id == transition_id && value.supported)
                    .ok_or(AppError::InvalidChange)?;
                (
                    super::model::FieldValue {
                        id: Some(transition.target.id.clone()),
                        label: transition.target.name.clone(),
                        value: None,
                    },
                    Some(serde_json::to_string(&transition.target).map_err(db_error)?),
                    Some(transition.id),
                    Some(status.id.clone()),
                    None,
                    None,
                )
            }
            super::model::ChangeRequest::Assignee { account_id } => {
                let mut stmt=tx.prepare("SELECT assignees_json,can_assign FROM capabilities WHERE site=?1 AND account=?2 AND issue_id=?3 AND source_status_id=?4").map_err(db_error)?;
                let rows = stmt
                    .query_map(
                        params![owner.site_url, owner.email, issue_id, status.id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(db_error)?;
                let mut found = None;
                let mut can_unassign = false;
                for row in rows {
                    let (json, can_assign) = row.map_err(db_error)?;
                    if account_id.is_none() {
                        let allowed: bool = tx.query_row("SELECT can_unassign FROM capabilities WHERE site=?1 AND account=?2 AND issue_id=?3 AND source_status_id=?4 AND assignee_query=?5", params![owner.site_url, owner.email, issue_id, status.id, ""], |row| Ok(row.get::<_,i64>(0)? != 0)).optional().map_err(db_error)?.unwrap_or(false);
                        can_unassign = allowed;
                    } else if can_assign != 0 {
                        let users: Vec<super::model::Assignee> =
                            serde_json::from_str(&json).map_err(db_error)?;
                        if let Some(user) = users
                            .into_iter()
                            .find(|user| Some(user.id.as_str()) == account_id.as_deref())
                        {
                            found = Some(user);
                            break;
                        }
                    }
                }
                let requested_value = if let Some(user) = found {
                    super::model::FieldValue {
                        id: Some(user.id),
                        label: user.display_name,
                        value: None,
                    }
                } else if account_id.is_none() && can_unassign {
                    super::model::FieldValue {
                        id: None,
                        label: "Unassigned".into(),
                        value: None,
                    }
                } else {
                    return Err(AppError::InvalidChange);
                };
                (
                    requested_value,
                    None,
                    None,
                    Some(status.id.clone()),
                    None,
                    None,
                )
            }
            super::model::ChangeRequest::Summary {
                summary: requested_summary,
            } => {
                if requested_summary.trim().is_empty() {
                    return Err(AppError::InvalidChange);
                }
                let allowed: bool = tx.query_row("SELECT can_edit_summary FROM capabilities WHERE site=?1 AND account=?2 AND issue_id=?3 AND source_status_id=?4 AND assignee_query=?5", params![owner.site_url, owner.email, issue_id, status.id, ""], |row| Ok(row.get::<_,i64>(0)? != 0)).optional().map_err(db_error)?.unwrap_or(false);
                if !allowed {
                    return Err(AppError::InvalidChange);
                }
                (
                    super::model::FieldValue {
                        id: None,
                        label: requested_summary.clone(),
                        value: Some(Value::String(requested_summary)),
                    },
                    None,
                    None,
                    Some(status.id.clone()),
                    None,
                    None,
                )
            }
            super::model::ChangeRequest::Description { description } => {
                let allowed: bool = tx.query_row("SELECT can_edit_description FROM capabilities WHERE site=?1 AND account=?2 AND issue_id=?3 AND source_status_id=?4 AND assignee_query=?5", params![owner.site_url, owner.email, issue_id, status.id, ""], |row| Ok(row.get::<_,i64>(0)? != 0)).optional().map_err(db_error)?.unwrap_or(false);
                if !allowed {
                    return Err(AppError::InvalidChange);
                }
                (
                    super::model::FieldValue {
                        id: None,
                        label: "Description".into(),
                        value: Some(description),
                    },
                    None,
                    None,
                    Some(status.id.clone()),
                    None,
                    None,
                )
            }
            super::model::ChangeRequest::Sprint {
                source_sprint_id,
                target_sprint_id,
            } => {
                let detail = detail.as_ref().ok_or(AppError::NotConnected)?;
                if status.category == "done"
                    || status.category == "complete"
                    || !detail.issue.sprint_ids.contains(&source_sprint_id)
                {
                    return Err(AppError::InvalidChange);
                }
                let sprints_json: String = tx.query_row("SELECT sprints_json FROM workspaces WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4", params![owner.site_url, owner.email, project_key, board_id], |row| row.get(0)).optional().map_err(db_error)?.ok_or(AppError::NotConnected)?;
                let sprints: Vec<super::model::Sprint> =
                    serde_json::from_str(&sprints_json).map_err(db_error)?;
                let states = sprints
                    .iter()
                    .map(|sprint| (sprint.id, sprint.state.as_str()))
                    .collect::<HashMap<_, _>>();
                let live = detail
                    .issue
                    .sprint_ids
                    .iter()
                    .filter(|id| {
                        states
                            .get(*id)
                            .is_some_and(|state| *state == "active" || *state == "future")
                    })
                    .copied()
                    .collect::<Vec<_>>();
                if states.get(&source_sprint_id) != Some(&"active")
                    || states.get(&target_sprint_id) != Some(&"future")
                    || live.as_slice() != [source_sprint_id]
                {
                    return Err(AppError::InvalidChange);
                }
                let source_name = sprints
                    .iter()
                    .find(|sprint| sprint.id == source_sprint_id)
                    .map(|sprint| sprint.name.as_str())
                    .ok_or(AppError::InvalidChange)?;
                let target_name = sprints
                    .iter()
                    .find(|sprint| sprint.id == target_sprint_id)
                    .map(|sprint| sprint.name.as_str())
                    .ok_or(AppError::InvalidChange)?;
                let value = serde_json::json!({"sourceSprintId":source_sprint_id,"targetSprintId":target_sprint_id});
                (
                    super::model::FieldValue {
                        id: None,
                        label: format!("Move from {source_name} to {target_name}"),
                        value: Some(value),
                    },
                    None,
                    None,
                    Some(status.id.clone()),
                    Some(source_sprint_id),
                    Some(target_sprint_id),
                )
            }
        };
    let same_as_base = requested.same_value(&base);
    if let Some((id, old_base, _, _, state, _, attempted, _)) = &existing {
        if state != "queued" || *attempted != 0 {
            return Err(AppError::ChangeLocked);
        }
        let original: super::model::FieldValue =
            serde_json::from_str(old_base).map_err(db_error)?;
        if !original.same_value(&base) {
            return Err(AppError::ChangeLocked);
        }
        if same_as_base {
            tx.execute("UPDATE changes SET state='discarded',updated_at=?4 WHERE id=?1 AND site=?2 AND account=?3",params![id,owner.site_url,owner.email,chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
            tx.execute("UPDATE canonical_issues SET revision=revision+1 WHERE site=?1 AND account=?2 AND issue_id=?3",params![owner.site_url,owner.email,issue_id]).map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            return Ok(None);
        }
        tx.execute("UPDATE changes SET requested_json=?4,target_json=?5,transition_id=?6,source_status_id=?7,source_sprint_id=?8,target_sprint_id=?9,project_key=?10,board_id=?11,detail_json=?12,updated_at=?13 WHERE id=?1 AND site=?2 AND account=?3",params![id,owner.site_url,owner.email,serde_json::to_string(&requested).map_err(db_error)?,target,transition_id,source_status_id,source_sprint_id,target_sprint_id,project_key,board_id,canonical_detail.clone().unwrap_or_else(|| existing.as_ref().unwrap().7.clone()),chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
        tx.execute("UPDATE canonical_issues SET revision=revision+1 WHERE site=?1 AND account=?2 AND issue_id=?3",params![owner.site_url,owner.email,issue_id]).map_err(db_error)?;
        let result=tx.query_row("SELECT id,issue_id,issue_key,summary,project_key,board_id,field,state,attempted,base_json,requested_json,remote_json,error,created_at,accepted FROM changes WHERE id=?1",params![id],pending_from_row).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        return Ok(Some(result));
    }
    if same_as_base {
        tx.commit().map_err(db_error)?;
        return Ok(None);
    }
    let pin = match canonical_detail {
        Some(pin) => pin,
        None => tx.query_row("SELECT detail_json FROM issues WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 AND issue_id=?5",params![owner.site_url,owner.email,project_key,board_id,issue_id],|row|row.get(0)).optional().map_err(db_error)?.ok_or(AppError::NotConnected)?,
    };
    let sequence: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM changes WHERE site=?1 AND account=?2",
            params![owner.site_url, owner.email],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute("INSERT INTO changes(site,account,issue_id,issue_key,summary,project_key,board_id,field,state,base_json,requested_json,target_json,transition_id,source_status_id,source_sprint_id,target_sprint_id,attempted,sequence,created_at,updated_at,detail_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued',?9,?10,?11,?12,?13,?14,?15,0,?16,?17,?17,?18)",params![owner.site_url,owner.email,issue_id,issue_key,summary,project_key,board_id,field,serde_json::to_string(&base).map_err(db_error)?,serde_json::to_string(&requested).map_err(db_error)?,target,transition_id,source_status_id,source_sprint_id,target_sprint_id,sequence,now,pin]).map_err(db_error)?;
    tx.execute("UPDATE canonical_issues SET revision=revision+1 WHERE site=?1 AND account=?2 AND issue_id=?3",params![owner.site_url,owner.email,issue_id]).map_err(db_error)?;
    let id = tx.last_insert_rowid();
    let result=tx.query_row("SELECT id,issue_id,issue_key,summary,project_key,board_id,field,state,attempted,base_json,requested_json,remote_json,error,created_at,accepted FROM changes WHERE id=?1",params![id],pending_from_row).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    let _ = updated;
    Ok(Some(result))
}

pub(super) fn load_change(
    db: &Connection,
    owner: &Owner,
    id: i64,
) -> Result<Option<super::model::StoredChange>> {
    let mut stmt=db.prepare("SELECT id,issue_id,issue_key,summary,project_key,board_id,field,state,attempted,base_json,requested_json,remote_json,error,created_at,accepted,transition_id,source_status_id,updated_at,source_sprint_id,target_sprint_id FROM changes WHERE site=?1 AND account=?2 AND id=?3").map_err(db_error)?;
    let mut rows = stmt
        .query(params![owner.site_url, owner.email, id])
        .map_err(db_error)?;
    match rows.next().map_err(db_error)? {
        Some(row) => Ok(Some(super::model::StoredChange {
            change: pending_from_row(row).map_err(db_error)?,
            transition_id: row.get(15).map_err(db_error)?,
            source_status_id: row.get(16).map_err(db_error)?,
            accepted: row.get::<_, i64>(14).map_err(db_error)? != 0,
            version: row.get(17).map_err(db_error)?,
            source_sprint_id: row.get(18).map_err(db_error)?,
            target_sprint_id: row.get(19).map_err(db_error)?,
        })),
        None => Ok(None),
    }
}

fn bump_revision(db: &Connection, owner: &Owner, issue_id: &str) -> Result<i64> {
    db.execute("UPDATE canonical_issues SET revision=revision+1 WHERE site=?1 AND account=?2 AND issue_id=?3",params![owner.site_url,owner.email,issue_id]).map_err(db_error)?;
    db.query_row(
        "SELECT revision FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id=?3",
        params![owner.site_url, owner.email, issue_id],
        |row| row.get(0),
    )
    .map_err(db_error)
}

fn apply_remote_to_detail(detail: &mut IssueDetail, remote: &super::model::RemoteFields) {
    detail.issue.id = remote.issue_id.clone();
    detail.issue.key = remote.key.clone();
    detail.issue.status = remote.status.clone();
    detail.issue.assignee = remote.assignee.clone();
    detail.issue.updated = remote.updated.clone();
    if let Some(summary) = &remote.summary {
        detail.issue.summary = summary.clone();
        detail
            .fields
            .insert("summary".into(), Value::String(summary.clone()));
    }
    if let Some(description) = &remote.description {
        detail.description = description.clone();
        detail
            .fields
            .insert("description".into(), description.clone());
    }
    let status_raw = raw_status(detail.fields.get("status"), &remote.status);
    let assignee_raw = raw_assignee(detail.fields.get("assignee"), remote.assignee.as_ref());
    detail.fields.insert("status".into(), status_raw);
    detail.fields.insert("assignee".into(), assignee_raw);
}

fn update_remote_tx(
    db: &Connection,
    owner: &Owner,
    remote: &super::model::RemoteFields,
    bump: bool,
) -> Result<i64> {
    if remote.issue_id.is_empty() || remote.key.is_empty() {
        return Err(AppError::InvalidChange);
    }
    let old:Option<(String,String,String,Option<String>,String,i64,Option<String>)>=db.query_row("SELECT issue_key,summary,status_json,assignee_json,updated,revision,detail_json FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id=?3",params![owner.site_url,owner.email,remote.issue_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional().map_err(db_error)?;
    let status_json = serde_json::to_string(&remote.status).map_err(db_error)?;
    let assignee_json = serde_json::to_string(&remote.assignee).map_err(db_error)?;
    let (old_summary, revision, old_status, detail_json) = if let Some((
        _,
        summary,
        old_status,
        _,
        old_updated,
        revision,
        detail,
    )) = old
    {
        let old_time = parse_jira_time(&old_updated);
        let new_time = parse_jira_time(&remote.updated);
        if new_time.is_none() {
            return Err(AppError::UncertainBaseline);
        }
        if old_time.zip(new_time).is_some_and(|(old, new)| new < old) {
            db.execute("UPDATE canonical_issues SET uncertain=1 WHERE site=?1 AND account=?2 AND issue_id=?3",params![owner.site_url,owner.email,remote.issue_id]).map_err(db_error)?;
            return Err(AppError::UncertainBaseline);
        }
        (summary, revision, old_status, detail)
    } else {
        (String::new(), 0, String::new(), None)
    };
    let summary = remote.summary.as_deref().unwrap_or(&old_summary);
    let mut detail = detail_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<IssueDetail>(json).ok());
    if let Some(detail) = &mut detail {
        apply_remote_to_detail(detail, remote);
    }
    let detail_json = detail
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(db_error)?;
    db.execute("INSERT INTO canonical_issues(site,account,issue_id,issue_key,summary,status_json,assignee_json,updated,revision,uncertain,detail_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0,?10) ON CONFLICT(site,account,issue_id) DO UPDATE SET issue_key=excluded.issue_key,summary=excluded.summary,status_json=excluded.status_json,assignee_json=excluded.assignee_json,updated=excluded.updated,uncertain=0,detail_json=COALESCE(excluded.detail_json,canonical_issues.detail_json)",params![owner.site_url,owner.email,remote.issue_id,remote.key,summary,status_json,assignee_json,remote.updated,revision,detail_json]).map_err(db_error)?;
    let mut stmt=db.prepare("SELECT id,detail_json FROM changes WHERE site=?1 AND account=?2 AND issue_id=?3 AND state NOT IN ('confirmed','discarded')").map_err(db_error)?;
    let rows = stmt
        .query_map(
            params![owner.site_url, owner.email, remote.issue_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(db_error)?;
    let mut pins = vec![];
    for row in rows {
        pins.push(row.map_err(db_error)?);
    }
    drop(stmt);
    for (id, json) in pins {
        if let Ok(mut detail) = serde_json::from_str::<IssueDetail>(&json) {
            apply_remote_to_detail(&mut detail, remote);
            db.execute(
                "UPDATE changes SET detail_json=?4 WHERE id=?1 AND site=?2 AND account=?3",
                params![
                    id,
                    owner.site_url,
                    owner.email,
                    serde_json::to_string(&detail).map_err(db_error)?
                ],
            )
            .map_err(db_error)?;
        }
    }
    if old_status != status_json {
        db.execute("UPDATE capabilities SET transitions_json='[]',transitions_at=NULL WHERE site=?1 AND account=?2 AND issue_id=?3 AND source_status_id<>?4",params![owner.site_url,owner.email,remote.issue_id,remote.status.id]).map_err(db_error)?;
    }
    if bump {
        bump_revision(db, owner, &remote.issue_id)
    } else {
        Ok(revision)
    }
}

pub(super) fn update_remote(
    db: &mut Connection,
    owner: &Owner,
    remote: &super::model::RemoteFields,
) -> Result<i64> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let revision = update_remote_tx(&tx, owner, remote, true)?;
    tx.commit().map_err(db_error)?;
    Ok(revision)
}

fn cas_change(db: &Connection, owner: &Owner, stored: &super::model::StoredChange) -> Result<bool> {
    let changed=db.query_row("SELECT EXISTS(SELECT 1 FROM changes WHERE id=?1 AND site=?2 AND account=?3 AND state=?4 AND updated_at=?5 AND requested_json=?6 AND base_json=?7)",params![stored.change.id,owner.site_url,owner.email,stored.change.state,stored.version,serde_json::to_string(&stored.change.requested).map_err(db_error)?,serde_json::to_string(&stored.change.base).map_err(db_error)?],|row|row.get::<_,i64>(0)).map_err(db_error)?;
    Ok(changed != 0)
}

pub(super) fn set_change_state(
    db: &mut Connection,
    owner: &Owner,
    stored: &super::model::StoredChange,
    state: &str,
    error: Option<&str>,
    remote: Option<&super::model::FieldValue>,
    attempted: bool,
) -> Result<bool> {
    if !matches!(
        state,
        "queued"
            | "sending"
            | "confirming"
            | "blocked"
            | "conflict"
            | "unknown"
            | "confirmed"
            | "discarded"
    ) {
        return Err(AppError::InvalidChange);
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if !cas_change(&tx, owner, stored)? {
        tx.commit().map_err(db_error)?;
        return Ok(false);
    }
    tx.execute("UPDATE changes SET state=?4,error=?5,remote_json=?6,attempted=?7,accepted=CASE WHEN ?4='confirming' THEN 1 ELSE accepted END,updated_at=?8 WHERE id=?1 AND site=?2 AND account=?3",params![stored.change.id,owner.site_url,owner.email,state,error,remote.map(serde_json::to_string).transpose().map_err(db_error)?,attempted as i64,chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
    bump_revision(&tx, owner, &stored.change.issue_id)?;
    tx.commit().map_err(db_error)?;
    Ok(true)
}

pub(super) fn finish_change(
    db: &mut Connection,
    owner: &Owner,
    stored: &super::model::StoredChange,
    remote: &super::model::RemoteFields,
    discard: bool,
) -> Result<bool> {
    if remote.issue_id != stored.change.issue_id {
        return Err(AppError::InvalidChange);
    }
    if !discard && !remote.matches_requested(&stored.change.field, &stored.change.requested) {
        return Err(AppError::InvalidChange);
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if !cas_change(&tx, owner, stored)? {
        tx.commit().map_err(db_error)?;
        return Ok(false);
    }
    update_remote_tx(&tx, owner, remote, false)?;
    if !discard && stored.change.field == "sprint" {
        apply_sprint_move(&tx, owner, stored, remote)?;
    }
    tx.execute("UPDATE changes SET state=?4,error=NULL,remote_json=?5,updated_at=?6 WHERE id=?1 AND site=?2 AND account=?3",params![stored.change.id,owner.site_url,owner.email,if discard{"discarded"}else{"confirmed"},serde_json::to_string(&stored.change.requested).map_err(db_error)?,chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
    bump_revision(&tx, owner, &stored.change.issue_id)?;
    tx.commit().map_err(db_error)?;
    Ok(true)
}

fn apply_sprint_move(
    db: &Connection,
    owner: &Owner,
    stored: &super::model::StoredChange,
    remote: &super::model::RemoteFields,
) -> Result<()> {
    let (Some(source), Some(target)) = (stored.source_sprint_id, stored.target_sprint_id) else {
        return Err(AppError::InvalidChange);
    };
    let copies: Vec<(String, i64, String, String)> = {
        let mut stmt = db.prepare("SELECT project_key,board_id,summary_json,detail_json FROM issues WHERE site=?1 AND account=?2 AND issue_id=?3").map_err(db_error)?;
        let rows = stmt
            .query_map(
                params![owner.site_url, owner.email, stored.change.issue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?
    };
    let mut target_boards = Vec::new();
    for (project, board, summary_json, detail_json) in copies {
        let mut summary: IssueSummary = serde_json::from_str(&summary_json).map_err(db_error)?;
        let mut detail: IssueDetail = serde_json::from_str(&detail_json).map_err(db_error)?;
        apply_remote_to_detail(&mut detail, remote);
        if project == stored.change.project_key && board == stored.change.board_id {
            summary.sprint_ids = remote.sprint_ids.clone();
            detail.issue.sprint_ids = remote.sprint_ids.clone();
            target_boards.push((project.clone(), board));
        } else {
            summary.sprint_ids.retain(|id| *id != source);
            detail.issue.sprint_ids.retain(|id| *id != source);
            let sprints_json: Option<String> = db.query_row("SELECT sprints_json FROM workspaces WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4", params![owner.site_url,owner.email,project,board], |row| row.get(0)).optional().map_err(db_error)?;
            let target_known = sprints_json
                .and_then(|json| serde_json::from_str::<Vec<super::model::Sprint>>(&json).ok())
                .is_some_and(|sprints| sprints.iter().any(|sprint| sprint.id == target));
            if target_known {
                if !summary.sprint_ids.contains(&target) {
                    summary.sprint_ids.push(target);
                }
                if !detail.issue.sprint_ids.contains(&target) {
                    detail.issue.sprint_ids.push(target);
                }
                target_boards.push((project.clone(), board));
            }
        }
        db.execute("UPDATE issues SET summary_json=?6,detail_json=?7 WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 AND issue_id=?5", params![owner.site_url,owner.email,project,board,stored.change.issue_id,serde_json::to_string(&summary).map_err(db_error)?,serde_json::to_string(&detail).map_err(db_error)?]).map_err(db_error)?;
    }
    db.execute("DELETE FROM memberships WHERE site=?1 AND account=?2 AND issue_id=?3 AND view='current' AND sprint_id=?4", params![owner.site_url,owner.email,stored.change.issue_id,source]).map_err(db_error)?;
    db.execute("DELETE FROM memberships WHERE site=?1 AND account=?2 AND issue_id=?3 AND view='future' AND sprint_id=?4", params![owner.site_url,owner.email,stored.change.issue_id,target]).map_err(db_error)?;
    db.execute("DELETE FROM memberships WHERE site=?1 AND account=?2 AND issue_id=?3 AND view='current' AND sprint_id=0 AND NOT EXISTS(SELECT 1 FROM memberships current_member WHERE current_member.site=memberships.site AND current_member.account=memberships.account AND current_member.project_key=memberships.project_key AND current_member.board_id=memberships.board_id AND current_member.issue_id=memberships.issue_id AND current_member.view='current' AND current_member.sprint_id<>0)", params![owner.site_url,owner.email,stored.change.issue_id]).map_err(db_error)?;
    target_boards.sort();
    target_boards.dedup();
    for (project, board) in target_boards {
        let rank: i64 = db.query_row("SELECT COALESCE(MAX(rank),-1)+1 FROM memberships WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 AND view='future' AND sprint_id=?5", params![owner.site_url,owner.email,project,board,target], |row| row.get(0)).map_err(db_error)?;
        db.execute("INSERT INTO memberships(site,account,project_key,board_id,view,sprint_id,issue_id,rank) VALUES(?1,?2,?3,?4,'future',?5,?6,?7)", params![owner.site_url,owner.email,project,board,target,stored.change.issue_id,rank]).map_err(db_error)?;
    }
    Ok(())
}

pub(super) fn discard_local(
    db: &mut Connection,
    owner: &Owner,
    stored: &super::model::StoredChange,
) -> Result<bool> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    // Sending/confirming/unknown may have a live Jira effect. Queued includes
    // definitive rejections; blocked/conflict intents can be canceled locally.
    if !matches!(
        stored.change.state.as_str(),
        "queued" | "blocked" | "conflict"
    ) || !cas_change(&tx, owner, stored)?
    {
        tx.commit().map_err(db_error)?;
        return Ok(false);
    }
    tx.execute(
        "UPDATE changes SET state='discarded',updated_at=?4 WHERE id=?1 AND site=?2 AND account=?3",
        params![
            stored.change.id,
            owner.site_url,
            owner.email,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .map_err(db_error)?;
    bump_revision(&tx, owner, &stored.change.issue_id)?;
    tx.commit().map_err(db_error)?;
    Ok(true)
}

pub(super) fn rebase_change(
    db: &mut Connection,
    owner: &Owner,
    stored: &super::model::StoredChange,
    remote: &super::model::RemoteFields,
) -> Result<bool> {
    if remote.issue_id != stored.change.issue_id {
        return Err(AppError::InvalidChange);
    }
    let field_value = remote
        .field_value(&stored.change.field)
        .ok_or(AppError::InvalidChange)?;
    if remote.matches_requested(&stored.change.field, &stored.change.requested) {
        return Err(AppError::InvalidChange);
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if !cas_change(&tx, owner, stored)? {
        tx.commit().map_err(db_error)?;
        return Ok(false);
    }
    if !matches!(stored.change.state.as_str(), "conflict" | "blocked")
        || (stored.accepted && stored.change.state == "blocked")
    {
        return Err(AppError::ChangeLocked);
    }
    update_remote_tx(&tx, owner, remote, false)?;
    tx.execute("UPDATE changes SET state='queued',base_json=?4,source_status_id=?5,error=NULL,remote_json=NULL,attempted=0,accepted=0,updated_at=?6 WHERE id=?1 AND site=?2 AND account=?3",params![stored.change.id,owner.site_url,owner.email,serde_json::to_string(&field_value).map_err(db_error)?,remote.status.id,chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
    bump_revision(&tx, owner, &stored.change.issue_id)?;
    tx.commit().map_err(db_error)?;
    Ok(true)
}

pub(super) fn recover_sending(db: &mut Connection) -> Result<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let mut stmt = tx
        .prepare("SELECT site,account,issue_id FROM changes WHERE state='sending'")
        .map_err(db_error)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(db_error)?;
    let mut keys = vec![];
    for row in rows {
        keys.push(row.map_err(db_error)?);
    }
    drop(stmt);
    tx.execute("UPDATE changes SET state='unknown',error='The app stopped while Jira may have been applying this change.',updated_at=?1 WHERE state='sending'",params![chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
    for (site, account, issue_id) in keys {
        tx.execute("UPDATE canonical_issues SET revision=revision+1 WHERE site=?1 AND account=?2 AND issue_id=?3",params![site,account,issue_id]).map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

pub(super) fn revision(db: &Connection, owner: &Owner, issue_id: Option<&str>) -> Result<i64> {
    if let Some(issue_id) = issue_id {
        db.query_row(
            "SELECT revision FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id=?3",
            params![owner.site_url, owner.email, issue_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)
        .map(|value| value.unwrap_or(0))
    } else {
        db.query_row(
            "SELECT COALESCE(SUM(revision),0) FROM canonical_issues WHERE site=?1 AND account=?2",
            params![owner.site_url, owner.email],
            |row| row.get(0),
        )
        .map_err(db_error)
    }
}

#[cfg(test)]
pub(super) fn support(
    db: &Connection,
    owner: &Owner,
    project_key: &str,
    board_id: i64,
) -> Result<Option<Value>> {
    let json: Option<String> = db.query_row("SELECT support_json FROM workspaces WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4",params![owner.site_url,owner.email,project_key,board_id],|r|r.get(0)).optional().map_err(db_error)?;
    json.map(|json| serde_json::from_str(&json).map_err(db_error))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::model::{
        Assignee, Column, Comment, IssueStatus, Membership, Snapshot, Sprint, WorkspaceRef,
    };
    use serde_json::json;

    fn demote_to_v1(db: &Connection) {
        db.execute_batch("DROP TABLE capabilities; DROP TABLE changes; DROP TABLE canonical_issues; PRAGMA user_version=1;").unwrap();
    }

    fn owner(email: &str) -> Owner {
        Owner {
            site_url: "https://example.atlassian.net".into(),
            email: email.into(),
        }
    }
    fn snapshot() -> Snapshot {
        let summary = IssueSummary {
            id: "1".into(),
            key: "CK-1".into(),
            summary: "Finished in current sprint".into(),
            status: IssueStatus {
                id: "42".into(),
                name: "Done".into(),
                category: "done".into(),
            },
            assignee: Some(Assignee {
                id: "abc".into(),
                display_name: "Yi".into(),
            }),
            issue_type: "Task".into(),
            priority: None,
            story_points: Some(3.0),
            versions: vec!["ck-admin-4.44.0".into()],
            sprint_ids: vec![11],
            epic: None,
            updated: "2026-09-01T10:00:00.000+0000".into(),
            off_board: false,
        };
        let detail = IssueDetail {
            issue: summary.clone(),
            description: json!({"type":"doc","version":1,"content":[{"type":"unknownNode"}]}),
            fields: serde_json::from_value(json!({"status":{"id":"42","name":"Done","statusCategory":{"key":"done","id":3},"extra":"preserve"},"assignee":{"accountId":"abc","displayName":"Yi","avatarUrl":"preserve"},"customfield_9":{"opaque":true}})).unwrap(),
            field_names: serde_json::from_value(json!({"customfield_9":"Opaque field"})).unwrap(),
            comments: vec![Comment {
                id: "c1".into(),
                author: "Yi".into(),
                created: "t1".into(),
                updated: "t1".into(),
                body: json!({"type":"doc","version":1,"content":[]}),
            }],
            attachments: vec![],
        };
        Snapshot {
            workspace: CachedWorkspace {
                reference: WorkspaceRef {
                    project_key: "CK".into(),
                    board_id: 7,
                    project_name: "CargoKing".into(),
                    board_name: "Main".into(),
                    last_synced_at: "t1".into(),
                },
                columns: vec![Column {
                    name: "Done".into(),
                    status_ids: vec!["42".into()],
                }],
                sprints: vec![Sprint {
                    id: 11,
                    name: "Current".into(),
                    state: "active".into(),
                    start_date: None,
                    end_date: None,
                    goal: None,
                }],
                issue_count: 1,
                comment_count: 1,
            },
            support: json!({"versions":[{"name":"ck-admin-4.44.0"}]}),
            issues: vec![CachedIssue {
                summary,
                detail,
                rank: 0,
            }],
            memberships: vec![
                Membership {
                    view: "current",
                    sprint_id: 0,
                    issue_id: "1".into(),
                    rank: 0,
                },
                Membership {
                    view: "current",
                    sprint_id: 11,
                    issue_id: "1".into(),
                    rank: 0,
                },
            ],
        }
    }
    fn edit_capabilities() -> super::super::model::IssueCapabilities {
        super::super::model::IssueCapabilities {
            source_status_id: "42".into(),
            transitions_captured_at: Some("captured".into()),
            assignees_captured_at: Some("captured".into()),
            can_unassign: true,
            can_edit_summary: true,
            can_edit_description: true,
            edit_capabilities_at: Some("captured".into()),
            transitions: vec![
                super::super::model::CapabilityTransition {
                    id: "to-progress".into(),
                    name: "Start".into(),
                    target: IssueStatus {
                        id: "50".into(),
                        name: "In Progress".into(),
                        category: "inprogress".into(),
                    },
                    supported: true,
                    reason: None,
                },
                super::super::model::CapabilityTransition {
                    id: "to-review".into(),
                    name: "Review".into(),
                    target: IssueStatus {
                        id: "51".into(),
                        name: "In Review".into(),
                        category: "indeterminate".into(),
                    },
                    supported: true,
                    reason: None,
                },
                super::super::model::CapabilityTransition {
                    id: "back".into(),
                    name: "Back".into(),
                    target: IssueStatus {
                        id: "42".into(),
                        name: "Done".into(),
                        category: "done".into(),
                    },
                    supported: true,
                    reason: None,
                },
            ],
            assignees: vec![Assignee {
                id: "u2".into(),
                display_name: "Teammate".into(),
            }],
            can_assign: true,
            assignee_query: "".into(),
            assignees_complete: false,
        }
    }
    #[test]
    fn cache_reopens_and_keeps_accounts_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite3");
        let mut db = open(&path).unwrap();
        publish(&mut db, &owner("yi@example.com"), &snapshot()).unwrap();
        drop(db);
        let db = open(&path).unwrap();
        assert_eq!(
            workspace(&db, &owner("yi@example.com"), "CK", 7)
                .unwrap()
                .unwrap()
                .issue_count,
            1
        );
        assert!(workspace(&db, &owner("someone@example.com"), "CK", 7)
            .unwrap()
            .is_none());
        assert!(workspace(
            &db,
            &Owner {
                site_url: "https://other.atlassian.net".into(),
                email: "yi@example.com".into()
            },
            "CK",
            7
        )
        .unwrap()
        .is_none());
        assert!(workspace(&db, &owner("yi@example.com"), "OTHER", 7)
            .unwrap()
            .is_none());
        assert!(workspace(&db, &owner("yi@example.com"), "CK", 8)
            .unwrap()
            .is_none());
        assert_eq!(list(&db, &owner("someone@example.com")).unwrap().len(), 0);
        let filter = IssueFilter {
            project_key: "CK".into(),
            board_id: 7,
            view: "current".into(),
            sprint_id: Some(11),
            search: "Finished".into(),
            offset: 0,
            limit: 50,
        };
        let page = issues(&db, &owner("yi@example.com"), &filter).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.issues[0].status.category, "done");
        assert_eq!(
            issues(&db, &owner("someone@example.com"), &filter)
                .unwrap()
                .total,
            0
        );
        assert!(issue(&db, &owner("yi@example.com"), "CK", 8, "1")
            .unwrap()
            .is_none());
        assert!(issue(&db, &owner("yi@example.com"), "OTHER", 7, "1")
            .unwrap()
            .is_none());
        let detail = issue(&db, &owner("yi@example.com"), "CK", 7, "1")
            .unwrap()
            .unwrap();
        assert_eq!(detail.fields["customfield_9"]["opaque"], true);
        assert_eq!(detail.comments.len(), 1);
        assert_eq!(
            support(&db, &owner("yi@example.com"), "CK", 7)
                .unwrap()
                .unwrap()["versions"][0]["name"],
            "ck-admin-4.44.0"
        );
    }
    #[test]
    fn failed_publish_rolls_back_to_previous_complete_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = open(&dir.path().join("cache.sqlite3")).unwrap();
        publish(&mut db, &owner("yi@example.com"), &snapshot()).unwrap();
        let mut incomplete = snapshot();
        incomplete.workspace.reference.last_synced_at = "t2".into();
        incomplete.issues.clear();
        assert!(publish(&mut db, &owner("yi@example.com"), &incomplete).is_err());
        assert_eq!(
            workspace(&db, &owner("yi@example.com"), "CK", 7)
                .unwrap()
                .unwrap()
                .reference
                .last_synced_at,
            "t1"
        );
        assert!(issue(&db, &owner("yi@example.com"), "CK", 7, "1")
            .unwrap()
            .is_some());
    }
    #[test]
    fn newer_schema_is_not_recreated_or_wiped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite3");
        let db = open(&path).unwrap();
        db.execute_batch("PRAGMA user_version=4").unwrap();
        drop(db);
        assert!(matches!(open(&path), Err(AppError::CacheVersion)));
        let db = Connection::open(&path).unwrap();
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);
    }

    #[test]
    fn simultaneous_initial_opens_share_one_migration() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite3");
        let barrier = Arc::new(Barrier::new(4));
        let threads = (0..4)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    open(&path).map(|db| {
                        db.query_row::<i64, _, _>("PRAGMA user_version", [], |r| r.get(0))
                            .unwrap()
                    })
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            assert_eq!(thread.join().unwrap().unwrap(), 3);
        }
    }

    #[test]
    fn v1_migration_keeps_board_snapshots_and_selects_newest_duplicate_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite3");
        let mut db = open(&path).unwrap();
        let mut first = snapshot();
        first.issues[0].summary.updated = "2026-09-01T10:00:00.000+0000".into();
        first.issues[0].detail.issue = first.issues[0].summary.clone();
        publish(&mut db, &owner("yi@example.com"), &first).unwrap();
        let mut second = first.clone();
        second.workspace.reference.board_id = 8;
        second.workspace.reference.board_name = "Second board".into();
        second.issues[0].summary.updated = "2026-09-02T10:00:00.000+0000".into();
        second.issues[0].summary.status = IssueStatus {
            id: "99".into(),
            name: "In Progress".into(),
            category: "inprogress".into(),
        };
        second.issues[0].detail.issue = second.issues[0].summary.clone();
        second.issues[0]
            .detail
            .fields
            .insert("customfield_9".into(), json!({"migrated":true}));
        publish(&mut db, &owner("yi@example.com"), &second).unwrap();
        demote_to_v1(&db);
        drop(db);
        let db = open(&path).unwrap();
        assert_eq!(list(&db, &owner("yi@example.com")).unwrap().len(), 2);
        assert_eq!(
            workspace(&db, &owner("yi@example.com"), "CK", 7)
                .unwrap()
                .unwrap()
                .issue_count,
            1
        );
        let migrated = issue(&db, &owner("yi@example.com"), "CK", 8, "1")
            .unwrap()
            .unwrap();
        assert_eq!(migrated.fields["customfield_9"]["migrated"], true);
        assert_eq!(migrated.comments.len(), 1);
        assert_eq!(migrated.description["content"][0]["type"], "unknownNode");
        let page = issues(
            &db,
            &owner("yi@example.com"),
            &IssueFilter {
                project_key: "CK".into(),
                board_id: 7,
                view: "current".into(),
                sprint_id: Some(11),
                search: "".into(),
                offset: 0,
                limit: 20,
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
        let canonical:(String,i64)=db.query_row("SELECT updated,uncertain FROM canonical_issues WHERE site=?1 AND account=?2 AND issue_id='1'",params![owner("yi@example.com").site_url,owner("yi@example.com").email],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(canonical.0, "2026-09-02T10:00:00.000+0000");
        assert_eq!(
            canonical.1, 1,
            "divergent copies require a direct read before replay"
        );
    }

    #[test]
    fn failed_v1_migration_rolls_back_new_schema_and_retains_old_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite3");
        let mut db = open(&path).unwrap();
        publish(&mut db, &owner("yi@example.com"), &snapshot()).unwrap();
        let old: String = db
            .query_row(
                "SELECT detail_json FROM issues WHERE issue_id='1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        demote_to_v1(&db);
        db.execute(
            "UPDATE issues SET summary_json='broken' WHERE issue_id='1'",
            [],
        )
        .unwrap();
        drop(db);
        assert!(matches!(open(&path), Err(AppError::Cache)));
        let db = Connection::open(&path).unwrap();
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        assert_eq!(
            db.query_row(
                "SELECT detail_json FROM issues WHERE issue_id='1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            old
        );
        let table_count: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='canonical_issues'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 0);
    }

    #[test]
    fn exact_frontend_change_requests_deserialize() {
        let status: super::super::model::ChangeRequest =
            serde_json::from_value(json!({"field":"status","transitionId":"31"})).unwrap();
        assert!(
            matches!(status,super::super::model::ChangeRequest::Status{transition_id} if transition_id=="31")
        );
        let assignee: super::super::model::ChangeRequest =
            serde_json::from_value(json!({"field":"assignee","accountId":"account-9"})).unwrap();
        assert!(
            matches!(assignee,super::super::model::ChangeRequest::Assignee{account_id} if account_id.as_deref()==Some("account-9"))
        );
        let explicit_null: super::super::model::FieldValue =
            serde_json::from_str(r#"{"id":null,"label":"Description","value":null}"#).unwrap();
        assert_eq!(explicit_null.value, Some(Value::Null));
        let omitted: super::super::model::FieldValue =
            serde_json::from_str(r#"{"id":null,"label":"Assignee"}"#).unwrap();
        assert_eq!(omitted.value, None);
    }

    #[test]
    fn pending_sprint_move_projects_membership_before_count_and_pagination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite3");
        let mut db = open(&path).unwrap();
        let owner = owner("yi@example.com");
        let mut data = snapshot();
        data.issues[0].summary.status.category = "indeterminate".into();
        data.issues[0].detail.fields.insert(
            "status".into(),
            json!({"id":"42","name":"In Progress","statusCategory":{"key":"indeterminate"}}),
        );
        data.workspace.sprints.push(Sprint {
            id: 12,
            name: "Next".into(),
            state: "future".into(),
            start_date: None,
            end_date: None,
            goal: None,
        });
        data.workspace.issue_count = 150;
        data.issues.clear();
        data.memberships.clear();
        for rank in 0..150 {
            let mut issue = snapshot().issues.remove(0);
            issue.summary.id = (rank + 1).to_string();
            issue.summary.key = format!("CK-{}", rank + 1);
            issue.summary.status.category = "indeterminate".into();
            issue.detail.issue = issue.summary.clone();
            issue.rank = rank as i64;
            let id = issue.summary.id.clone();
            data.memberships.push(Membership {
                view: "current",
                sprint_id: 11,
                issue_id: id,
                rank: rank as i64,
            });
            data.issues.push(issue);
        }
        publish(&mut db, &owner, &data).unwrap();
        let mut other_board = snapshot();
        other_board.workspace.reference.board_id = 8;
        other_board.workspace.reference.board_name = "Other".into();
        other_board.workspace.sprints.push(Sprint {
            id: 12,
            name: "Next".into(),
            state: "future".into(),
            start_date: None,
            end_date: None,
            goal: None,
        });
        other_board.issues[0].summary.status.category = "indeterminate".into();
        other_board.issues[0].detail.issue.status.category = "indeterminate".into();
        publish(&mut db, &owner, &other_board).unwrap();
        let pending = enqueue(
            &mut db,
            &owner,
            "CK",
            7,
            "1",
            super::super::model::ChangeRequest::Sprint {
                source_sprint_id: 11,
                target_sprint_id: 12,
            },
        )
        .unwrap()
        .unwrap();
        let query = |view: &str, sprint_id: i64, offset: i64| IssueFilter {
            project_key: "CK".into(),
            board_id: 7,
            view: view.into(),
            sprint_id: Some(sprint_id),
            search: String::new(),
            offset,
            limit: 100,
        };
        let current = issues(&db, &owner, &query("current", 11, 0)).unwrap();
        assert_eq!(current.total, 149);
        assert_eq!(current.issues.len(), 100);
        let future = issues(&db, &owner, &query("future", 12, 0)).unwrap();
        assert_eq!(future.total, 1);
        assert_eq!(future.issues[0].id, "1");
        let other_current = issues(
            &db,
            &owner,
            &IssueFilter {
                project_key: "CK".into(),
                board_id: 8,
                view: "current".into(),
                sprint_id: Some(11),
                search: String::new(),
                offset: 0,
                limit: 100,
            },
        )
        .unwrap();
        let other_future = issues(
            &db,
            &owner,
            &IssueFilter {
                project_key: "CK".into(),
                board_id: 8,
                view: "future".into(),
                sprint_id: Some(12),
                search: String::new(),
                offset: 0,
                limit: 100,
            },
        )
        .unwrap();
        assert_eq!(other_current.total, 0);
        assert_eq!(
            other_future.total, 0,
            "do not invent the target sprint on another board"
        );
        let projected = issue(&db, &owner, "CK", 8, "1").unwrap().unwrap();
        assert!(!projected.issue.sprint_ids.contains(&11));
        assert!(!projected.issue.sprint_ids.contains(&12));
        let queued = load_change(&db, &owner, pending.id).unwrap().unwrap();
        assert!(set_change_state(&mut db, &owner, &queued, "sending", None, None, true).unwrap());
        let sending = load_change(&db, &owner, pending.id).unwrap().unwrap();
        assert!(
            set_change_state(&mut db, &owner, &sending, "confirming", None, None, true).unwrap()
        );
        let confirming = load_change(&db, &owner, pending.id).unwrap().unwrap();
        let remote = super::super::model::RemoteFields {
            issue_id: "1".into(),
            key: "CK-1".into(),
            project_key: "CK".into(),
            status: IssueStatus {
                id: "42".into(),
                name: "In Progress".into(),
                category: "indeterminate".into(),
            },
            assignee: Some(Assignee {
                id: "abc".into(),
                display_name: "Yi".into(),
            }),
            summary: Some("Finished in current sprint".into()),
            description: Some(json!({"type":"doc","version":1,"content":[]})),
            sprint_ids: vec![12, 9],
            open_sprint_ids: vec![12],
            updated: "2026-09-28T10:00:00Z".into(),
        };
        finish_change(&mut db, &owner, &confirming, &remote, false).unwrap();
        assert_eq!(
            issues(
                &db,
                &owner,
                &IssueFilter {
                    project_key: "CK".into(),
                    board_id: 8,
                    view: "future".into(),
                    sprint_id: Some(12),
                    search: String::new(),
                    offset: 0,
                    limit: 100
                }
            )
            .unwrap()
            .total,
            1
        );
        assert!(!issue(&db, &owner, "CK", 8, "1")
            .unwrap()
            .unwrap()
            .issue
            .sprint_ids
            .contains(&11));
    }

    #[test]
    fn queued_intents_project_across_boards_and_keep_a_pin_until_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite3");
        let mut db = open(&path).unwrap();
        let owner = owner("yi@example.com");
        publish(&mut db, &owner, &snapshot()).unwrap();
        let mut other = snapshot();
        other.workspace.reference.board_id = 8;
        other.workspace.reference.board_name = "Other".into();
        publish(&mut db, &owner, &other).unwrap();
        save_capabilities(&mut db, &owner, &edit_capabilities(), "1").unwrap();
        let first = enqueue(
            &mut db,
            &owner,
            "CK",
            7,
            "1",
            super::super::model::ChangeRequest::Status {
                transition_id: "to-progress".into(),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(first.state, "queued");
        let filter = IssueFilter {
            project_key: "CK".into(),
            board_id: 8,
            view: "current".into(),
            sprint_id: Some(11),
            search: "".into(),
            offset: 0,
            limit: 20,
        };
        assert_eq!(
            issues(&db, &owner, &filter).unwrap().issues[0].status.id,
            "50"
        );
        let projected = issue(&db, &owner, "CK", 8, "1").unwrap().unwrap();
        assert_eq!(projected.issue.status.id, "50");
        assert_eq!(
            projected.fields["status"]["statusCategory"]["key"],
            "inprogress"
        );
        assert_eq!(projected.fields["status"]["statusCategory"]["id"], 3);
        assert_eq!(projected.fields["status"]["extra"], "preserve");
        let replaced = enqueue(
            &mut db,
            &owner,
            "CK",
            8,
            "1",
            super::super::model::ChangeRequest::Status {
                transition_id: "to-review".into(),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(replaced.id, first.id);
        assert_eq!(replaced.base.id.as_deref(), Some("42"));
        assert_eq!(replaced.requested.id.as_deref(), Some("51"));
        assert!(enqueue(
            &mut db,
            &owner,
            "CK",
            8,
            "1",
            super::super::model::ChangeRequest::Status {
                transition_id: "back".into()
            }
        )
        .unwrap()
        .is_none());
        let assignment = enqueue(
            &mut db,
            &owner,
            "CK",
            8,
            "1",
            super::super::model::ChangeRequest::Assignee {
                account_id: Some("u2".into()),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(assignment.field, "assignee");
        let projected = issue(&db, &owner, "CK", 8, "1").unwrap().unwrap();
        assert_eq!(projected.issue.status.id, "42");
        assert_eq!(projected.issue.assignee.as_ref().unwrap().id, "u2");
        assert_eq!(projected.fields["assignee"]["accountId"], "u2");
        assert_eq!(projected.fields["assignee"]["avatarUrl"], "preserve");
        let mut empty = other.clone();
        empty.issues.clear();
        empty.memberships.clear();
        empty.workspace.issue_count = 0;
        empty.workspace.comment_count = 0;
        publish(&mut db, &owner, &empty).unwrap();
        assert!(
            issue(&db, &owner, "CK", 8, "1").unwrap().is_some(),
            "pending operation pins the last detail outside current board scope"
        );
        let loaded = load_change(&db, &owner, assignment.id).unwrap().unwrap();
        assert!(set_change_state(&mut db, &owner, &loaded, "sending", None, None, true).unwrap());
        let sending = load_change(&db, &owner, assignment.id).unwrap().unwrap();
        assert!(
            !discard_local(&mut db, &owner, &sending).unwrap(),
            "an in-flight operation cannot be canceled"
        );
        assert!(
            !set_change_state(&mut db, &owner, &loaded, "confirming", None, None, true).unwrap(),
            "a stale preflight cannot cross the CAS barrier"
        );
        let sending = load_change(&db, &owner, assignment.id).unwrap().unwrap();
        assert!(
            set_change_state(&mut db, &owner, &sending, "confirming", None, None, true).unwrap()
        );
        let confirming = load_change(&db, &owner, assignment.id).unwrap().unwrap();
        let remote = super::super::model::RemoteFields {
            issue_id: "1".into(),
            key: "CK-1".into(),
            project_key: "CK".into(),
            status: snapshot().issues[0].summary.status.clone(),
            assignee: Some(Assignee {
                id: "u2".into(),
                display_name: "Renamed teammate".into(),
            }),
            summary: Some("Finished in current sprint".into()),
            description: Some(Value::Null),
            sprint_ids: vec![11],
            open_sprint_ids: vec![],
            updated: "2026-09-03T10:00:00.000+0000".into(),
        };
        assert!(finish_change(&mut db, &owner, &confirming, &remote, false).unwrap());
        assert!(list_changes(&db, &owner).unwrap().is_empty());
        assert_eq!(
            issue(&db, &owner, "CK", 7, "1")
                .unwrap()
                .unwrap()
                .issue
                .assignee
                .unwrap()
                .display_name,
            "Renamed teammate"
        );
        assert!(
            issue(&db, &owner, "CK", 8, "1").unwrap().is_none(),
            "resolved out-of-scope item releases its pin"
        );

        let status_change = enqueue(
            &mut db,
            &owner,
            "CK",
            7,
            "1",
            super::super::model::ChangeRequest::Status {
                transition_id: "to-progress".into(),
            },
        )
        .unwrap()
        .unwrap();
        let queued = load_change(&db, &owner, status_change.id).unwrap().unwrap();
        set_change_state(&mut db, &owner, &queued, "sending", None, None, true).unwrap();
        let sending = load_change(&db, &owner, status_change.id).unwrap().unwrap();
        set_change_state(&mut db, &owner, &sending, "confirming", None, None, true).unwrap();
        let confirming = load_change(&db, &owner, status_change.id).unwrap().unwrap();
        let renamed_status = super::super::model::RemoteFields {
            issue_id: "1".into(),
            key: "CK-1".into(),
            project_key: "CK".into(),
            status: IssueStatus {
                id: "50".into(),
                name: "Renamed status".into(),
                category: "inprogress".into(),
            },
            assignee: Some(Assignee {
                id: "u2".into(),
                display_name: "Renamed teammate".into(),
            }),
            summary: Some("Finished in current sprint".into()),
            description: Some(Value::Null),
            sprint_ids: vec![11],
            open_sprint_ids: vec![],
            updated: "2026-09-04T10:00:00.000+0000".into(),
        };
        assert!(finish_change(&mut db, &owner, &confirming, &renamed_status, false).unwrap());
        assert_eq!(
            issue(&db, &owner, "CK", 7, "1")
                .unwrap()
                .unwrap()
                .issue
                .status
                .name,
            "Renamed status"
        );
    }

    #[test]
    fn queued_definitive_rejection_can_be_canceled_even_after_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = open(&dir.path().join("cache.sqlite3")).unwrap();
        let owner = owner("yi@example.com");
        publish(&mut db, &owner, &snapshot()).unwrap();
        save_capabilities(&mut db, &owner, &edit_capabilities(), "1").unwrap();
        let change = enqueue(
            &mut db,
            &owner,
            "CK",
            7,
            "1",
            super::super::model::ChangeRequest::Status {
                transition_id: "to-progress".into(),
            },
        )
        .unwrap()
        .unwrap();
        let queued = load_change(&db, &owner, change.id).unwrap().unwrap();
        assert!(set_change_state(&mut db, &owner, &queued, "sending", None, None, true).unwrap());
        let sending = load_change(&db, &owner, change.id).unwrap().unwrap();
        assert!(set_change_state(
            &mut db,
            &owner,
            &sending,
            "queued",
            Some("Rate limited"),
            None,
            true
        )
        .unwrap());
        let rejected = load_change(&db, &owner, change.id).unwrap().unwrap();
        assert!(rejected.change.attempted);
        assert!(discard_local(&mut db, &owner, &rejected).unwrap());
        assert!(list_changes(&db, &owner).unwrap().is_empty());
    }

    #[test]
    fn accepted_but_unreadable_write_stays_blocked_and_cannot_be_rebased() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = open(&dir.path().join("cache.sqlite3")).unwrap();
        let owner = owner("yi@example.com");
        publish(&mut db, &owner, &snapshot()).unwrap();
        save_capabilities(&mut db, &owner, &edit_capabilities(), "1").unwrap();
        let change = enqueue(
            &mut db,
            &owner,
            "CK",
            7,
            "1",
            super::super::model::ChangeRequest::Status {
                transition_id: "to-progress".into(),
            },
        )
        .unwrap()
        .unwrap();
        let queued = load_change(&db, &owner, change.id).unwrap().unwrap();
        set_change_state(&mut db, &owner, &queued, "sending", None, None, true).unwrap();
        let sending = load_change(&db, &owner, change.id).unwrap().unwrap();
        set_change_state(
            &mut db,
            &owner,
            &sending,
            "confirming",
            Some("Accepted; readback unavailable"),
            None,
            true,
        )
        .unwrap();
        let confirming = load_change(&db, &owner, change.id).unwrap().unwrap();
        assert!(confirming.accepted);
        set_change_state(
            &mut db,
            &owner,
            &confirming,
            "blocked",
            Some("Issue is unavailable"),
            None,
            true,
        )
        .unwrap();
        let blocked = load_change(&db, &owner, change.id).unwrap().unwrap();
        assert!(blocked.accepted);
        assert!(!blocked.change.can_retry);
        let remote = super::super::model::RemoteFields {
            issue_id: "1".into(),
            key: "CK-1".into(),
            project_key: "CK".into(),
            status: snapshot().issues[0].summary.status.clone(),
            assignee: snapshot().issues[0].summary.assignee.clone(),
            summary: Some("Finished in current sprint".into()),
            description: Some(Value::Null),
            sprint_ids: vec![11],
            open_sprint_ids: vec![],
            updated: "2026-09-02T10:00:00.000+0000".into(),
        };
        assert!(matches!(
            rebase_change(&mut db, &owner, &blocked, &remote),
            Err(AppError::ChangeLocked)
        ));
        assert!(
            discard_local(&mut db, &owner, &blocked).unwrap(),
            "explicit local acknowledgement remains available"
        );
    }

    #[test]
    fn accepted_conflict_can_be_explicitly_rebased_after_external_validation() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = open(&dir.path().join("cache.sqlite3")).unwrap();
        let owner = owner("yi@example.com");
        publish(&mut db, &owner, &snapshot()).unwrap();
        save_capabilities(&mut db, &owner, &edit_capabilities(), "1").unwrap();
        let change = enqueue(
            &mut db,
            &owner,
            "CK",
            7,
            "1",
            super::super::model::ChangeRequest::Status {
                transition_id: "to-progress".into(),
            },
        )
        .unwrap()
        .unwrap();
        let queued = load_change(&db, &owner, change.id).unwrap().unwrap();
        set_change_state(&mut db, &owner, &queued, "sending", None, None, true).unwrap();
        let sending = load_change(&db, &owner, change.id).unwrap().unwrap();
        set_change_state(&mut db, &owner, &sending, "confirming", None, None, true).unwrap();
        let confirming = load_change(&db, &owner, change.id).unwrap().unwrap();
        set_change_state(
            &mut db,
            &owner,
            &confirming,
            "conflict",
            Some("Readback differs"),
            Some(&super::super::model::FieldValue {
                id: Some("42".into()),
                label: "Done".into(),
                value: None,
            }),
            true,
        )
        .unwrap();
        let conflict = load_change(&db, &owner, change.id).unwrap().unwrap();
        assert!(conflict.accepted);
        let remote = super::super::model::RemoteFields {
            issue_id: "1".into(),
            key: "CK-1".into(),
            project_key: "CK".into(),
            status: snapshot().issues[0].summary.status.clone(),
            assignee: snapshot().issues[0].summary.assignee.clone(),
            summary: Some("Finished in current sprint".into()),
            description: Some(Value::Null),
            sprint_ids: vec![11],
            open_sprint_ids: vec![],
            updated: "2026-09-02T10:00:00.000+0000".into(),
        };
        // The coordinator performs fresh transition/permission validation before Keep mine.
        assert!(rebase_change(&mut db, &owner, &conflict, &remote).unwrap());
        let rebased = load_change(&db, &owner, change.id).unwrap().unwrap();
        assert_eq!(rebased.change.state, "queued");
        assert!(!rebased.accepted);
        assert!(!rebased.change.attempted);
        assert_eq!(rebased.change.base.id.as_deref(), Some("42"));
    }
}
