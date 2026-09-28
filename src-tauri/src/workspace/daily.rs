use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    cache,
    model::{IssueDetail, IssueSummary, Owner, Snapshot},
};
use crate::{AppError, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DailyIssue {
    pub issue: IssueSummary,
    pub hierarchy_level: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ObservationIssue {
    pub id: String,
    pub status_category: String,
    pub estimate: Option<f64>,
    pub hierarchy_level: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Observation {
    pub captured_at: String,
    pub estimate_field_id: Option<String>,
    pub estimate_label: String,
    pub issues: Vec<ObservationIssue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DailyData {
    pub(super) sprint_id: i64,
    pub(super) estimate_field_id: Option<String>,
    pub(super) estimate_label: String,
    pub(super) issues: Vec<DailyIssue>,
    pub(super) observations: Vec<Observation>,
}

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS sprint_observations (
        site TEXT NOT NULL, account TEXT NOT NULL, project_key TEXT NOT NULL,
        board_id INTEGER NOT NULL, sprint_id INTEGER NOT NULL,
        captured_at TEXT NOT NULL, observation_json TEXT NOT NULL,
        PRIMARY KEY(site,account,project_key,board_id,sprint_id,captured_at)
    );",
    )
    .map_err(|_| AppError::Cache)
}

fn hierarchy(detail: &IssueDetail) -> Option<i64> {
    detail
        .fields
        .get("issuetype")?
        .get("hierarchyLevel")?
        .as_i64()
}

fn estimate_metadata(support: &Value) -> (Option<String>, String) {
    let field = support.pointer("/boardConfig/estimation/field");
    let id = field.and_then(|v| v.get("fieldId")).and_then(Value::as_str);
    let label = match id {
        Some("timeoriginalestimate" | "timeestimate" | "timespent") => "Time estimate (seconds)",
        Some(_) => field
            .and_then(|v| v.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or("Configured estimate"),
        None => "No estimation field configured",
    };
    (id.map(str::to_owned), label.into())
}

// Called inside the same transaction that publishes a complete Jira snapshot.
pub(super) fn capture(db: &Connection, owner: &Owner, snapshot: &Snapshot) -> Result<()> {
    let key = &snapshot.workspace.reference;
    let (field, label) = estimate_metadata(&snapshot.support);
    for sprint in snapshot
        .workspace
        .sprints
        .iter()
        .filter(|s| s.state == "active")
    {
        let observation = Observation {
            captured_at: key.last_synced_at.clone(),
            estimate_field_id: field.clone(),
            estimate_label: label.clone(),
            issues: snapshot
                .issues
                .iter()
                .filter(|item| item.summary.sprint_ids.contains(&sprint.id))
                .map(|item| ObservationIssue {
                    id: item.summary.id.clone(),
                    status_category: item.summary.status.category.clone(),
                    estimate: item
                        .summary
                        .story_points
                        .filter(|n| n.is_finite() && *n >= 0.0),
                    hierarchy_level: hierarchy(&item.detail),
                })
                .collect(),
        };
        db.execute("INSERT OR IGNORE INTO sprint_observations(site,account,project_key,board_id,sprint_id,captured_at,observation_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![owner.site_url,owner.email,key.project_key,key.board_id,sprint.id,key.last_synced_at,serde_json::to_string(&observation).map_err(|_| AppError::Cache)?])
            .map_err(|_| AppError::Cache)?;
    }
    Ok(())
}

pub(super) fn read(
    db: &Connection,
    owner: &Owner,
    project: &str,
    board: i64,
    sprint_id: i64,
) -> Result<DailyData> {
    let tx = db.unchecked_transaction().map_err(|_| AppError::Cache)?;
    let workspace = cache::workspace(&tx, owner, project, board)?.ok_or(AppError::InvalidFilter)?;
    if !workspace
        .sprints
        .iter()
        .any(|s| s.id == sprint_id && s.state == "active")
    {
        return Err(AppError::InvalidFilter);
    }
    let support: String = tx.query_row("SELECT support_json FROM workspaces WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4", params![owner.site_url,owner.email,project,board], |r| r.get(0)).map_err(|_| AppError::Cache)?;
    let (estimate_field_id, estimate_label) =
        estimate_metadata(&serde_json::from_str(&support).map_err(|_| AppError::Cache)?);
    // Include pinned unresolved moves, even if a later snapshot stopped listing the issue.
    let ids = {
        let mut statement = tx.prepare("SELECT issue_id FROM issues WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 UNION SELECT issue_id FROM changes WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 AND state NOT IN ('confirmed','discarded')").map_err(|_| AppError::Cache)?;
        let values = statement
            .query_map(params![owner.site_url, owner.email, project, board], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|_| AppError::Cache)?;
        values
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| AppError::Cache)?
    };
    let mut issues = Vec::new();
    for id in ids {
        if let Some(detail) = cache::issue(&tx, owner, project, board, &id)? {
            if detail.issue.sprint_ids.contains(&sprint_id) {
                let hierarchy_level = hierarchy(&detail);
                issues.push(DailyIssue {
                    issue: detail.issue,
                    hierarchy_level,
                });
            }
        }
    }
    issues.sort_by(|a, b| a.issue.key.cmp(&b.issue.key));
    let observations = {
        let mut statement = tx.prepare("SELECT observation_json FROM sprint_observations WHERE site=?1 AND account=?2 AND project_key=?3 AND board_id=?4 AND sprint_id=?5 ORDER BY captured_at").map_err(|_| AppError::Cache)?;
        let rows = statement
            .query_map(
                params![owner.site_url, owner.email, project, board, sprint_id],
                |r| r.get::<_, String>(0),
            )
            .map_err(|_| AppError::Cache)?;
        let mut observations = Vec::new();
        for row in rows {
            observations.push(
                serde_json::from_str(&row.map_err(|_| AppError::Cache)?)
                    .map_err(|_| AppError::Cache)?,
            );
        }
        observations
    };
    tx.commit().map_err(|_| AppError::Cache)?;
    Ok(DailyData {
        sprint_id,
        estimate_field_id,
        estimate_label,
        issues,
        observations,
    })
}

#[cfg(test)]
mod tests {
    use super::super::model::{CachedWorkspace, Sprint, WorkspaceRef};
    use super::*;
    use serde_json::json;

    #[test]
    fn observations_are_atomic_idempotent_and_owner_scoped() {
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&db).unwrap();
        let owner = Owner {
            site_url: "https://test.invalid".into(),
            email: "one".into(),
        };
        let snapshot = Snapshot {
            workspace: CachedWorkspace {
                reference: WorkspaceRef {
                    project_key: "CK".into(),
                    project_name: "Test".into(),
                    board_id: 1,
                    board_name: "Test".into(),
                    last_synced_at: "2026-09-28T09:00:00Z".into(),
                },
                columns: vec![],
                sprints: vec![Sprint {
                    id: 1,
                    name: "Sprint".into(),
                    state: "active".into(),
                    start_date: None,
                    end_date: None,
                    goal: None,
                }],
                issue_count: 0,
                comment_count: 0,
            },
            support: json!({}),
            issues: vec![],
            memberships: vec![],
        };
        {
            let tx = db.transaction().unwrap();
            capture(&tx, &owner, &snapshot).unwrap();
            // A failed publication drops the transaction, including its history.
        }
        let count = |db: &Connection| {
            db.query_row("SELECT COUNT(*) FROM sprint_observations", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        assert_eq!(count(&db), 0);
        capture(&db, &owner, &snapshot).unwrap();
        capture(&db, &owner, &snapshot).unwrap();
        assert_eq!(count(&db), 1);
        capture(
            &db,
            &Owner {
                email: "two".into(),
                ..owner
            },
            &snapshot,
        )
        .unwrap();
        assert_eq!(count(&db), 2);
        assert_eq!(estimate_metadata(&json!({"boardConfig":{"estimation":{"field":{"fieldId":"timeoriginalestimate","displayName":"Estimate"}}}})).1,"Time estimate (seconds)");
    }

    #[test]
    fn daily_reads_complete_sprint_and_retains_history_across_snapshot_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = cache::open(&dir.path().join("workspace.sqlite")).unwrap();
        let owner = Owner {
            site_url: "https://test.invalid".into(),
            email: "one".into(),
        };
        let mut snapshot = Snapshot {
            workspace: serde_json::from_value(json!({"projectKey":"CK","projectName":"Test","boardId":1,"boardName":"Board","lastSyncedAt":"2026-09-28T09:00:00Z","columns":[],"sprints":[{"id":1,"name":"Sprint","state":"active"}],"issueCount":151,"commentCount":0})).unwrap(),
            support: json!({"boardConfig":{"estimation":{"field":{"fieldId":"timeoriginalestimate","displayName":"Original estimate"}}}}),
            issues: (0..151).map(|id| {
                let detail: IssueDetail = serde_json::from_value(json!({"issue":{"id":id.to_string(),"key":format!("CK-{id}"),"summary":"Task","status":{"id":"1","name":"To do","category":"new"},"assignee":null,"issueType":"Task","priority":null,"storyPoints":3600,"versions":[],"sprintIds":[1],"epic":null,"updated":"2026-09-28T09:00:00Z","offBoard":false},"description":null,"fields":{"issuetype":{"hierarchyLevel":0},"timeoriginalestimate":3600},"fieldNames":{},"comments":[],"attachments":[]})).unwrap();
                super::super::model::CachedIssue {summary:detail.issue.clone(),detail,rank:id}
            }).collect(),
            memberships: vec![],
        };
        cache::publish(&mut db, &owner, &snapshot).unwrap();
        let first = read(&db, &owner, "CK", 1, 1).unwrap();
        assert_eq!(first.issues.len(), 151);
        assert_eq!(first.observations[0].issues.len(), 151);
        assert_eq!(first.observations[0].issues[0].estimate, Some(3600.0));
        assert_eq!(first.estimate_label, "Time estimate (seconds)");
        snapshot.workspace.reference.last_synced_at = "2026-09-29T09:00:00Z".into();
        snapshot.issues.pop();
        cache::publish(&mut db, &owner, &snapshot).unwrap();
        let next = read(&db, &owner, "CK", 1, 1).unwrap();
        assert_eq!(next.issues.len(), 150);
        assert_eq!(next.observations.len(), 2);
        assert_eq!(next.observations[0].issues.len(), 151);
        assert!(read(
            &db,
            &Owner {
                email: "another".into(),
                ..owner
            },
            "CK",
            1,
            1
        )
        .is_err());
    }
}
