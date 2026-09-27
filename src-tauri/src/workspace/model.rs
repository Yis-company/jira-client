use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Owner {
    pub site_url: String,
    pub email: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceRef {
    pub project_key: String,
    pub board_id: i64,
    pub project_name: String,
    pub board_name: String,
    pub last_synced_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Column {
    pub name: String,
    pub status_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sprint {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub goal: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedWorkspace {
    #[serde(flatten)]
    pub reference: WorkspaceRef,
    pub columns: Vec<Column>,
    pub sprints: Vec<Sprint>,
    pub issue_count: usize,
    pub comment_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueSummary {
    pub id: String,
    pub key: String,
    pub summary: String,
    pub status: IssueStatus,
    pub assignee: Option<Assignee>,
    pub issue_type: String,
    pub priority: Option<String>,
    pub story_points: Option<f64>,
    pub versions: Vec<String>,
    pub sprint_ids: Vec<i64>,
    pub epic: Option<String>,
    pub updated: String,
    pub off_board: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueStatus {
    pub id: String,
    pub name: String,
    pub category: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Assignee {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Comment {
    pub id: String,
    pub author: String,
    pub created: String,
    pub updated: String,
    pub body: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Attachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueDetail {
    pub issue: IssueSummary,
    pub description: Value,
    pub fields: Map<String, Value>,
    pub field_names: Map<String, Value>,
    pub comments: Vec<Comment>,
    pub attachments: Vec<Attachment>,
}

#[derive(Clone, Debug)]
pub(crate) struct CachedIssue {
    pub summary: IssueSummary,
    pub detail: IssueDetail,
    pub rank: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct Membership {
    pub view: &'static str,
    pub sprint_id: i64,
    pub issue_id: String,
    pub rank: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub workspace: CachedWorkspace,
    pub support: Value,
    pub issues: Vec<CachedIssue>,
    pub memberships: Vec<Membership>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueFilter {
    pub project_key: String,
    pub board_id: i64,
    pub view: String,
    pub sprint_id: Option<i64>,
    pub search: String,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct IssuePage {
    pub issues: Vec<IssueSummary>,
    pub total: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FieldValue {
    pub id: Option<String>,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingChange {
    pub project_key: String,
    pub board_id: i64,
    pub id: i64,
    pub issue_id: String,
    pub issue_key: String,
    pub summary: String,
    pub field: String,
    pub state: String,
    pub base: FieldValue,
    pub requested: FieldValue,
    pub remote: Option<FieldValue>,
    pub error: Option<String>,
    pub attempted: bool,
    pub can_retry: bool,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFields {
    pub issue_id: String,
    pub key: String,
    pub project_key: String,
    pub status: IssueStatus,
    pub assignee: Option<Assignee>,
    pub updated: String,
}

impl RemoteFields {
    pub fn field_value(&self, field: &str) -> Option<FieldValue> {
        match field {
            "status" => Some(FieldValue {
                id: Some(self.status.id.clone()),
                label: self.status.name.clone(),
            }),
            "assignee" => Some(FieldValue {
                id: self.assignee.as_ref().map(|value| value.id.clone()),
                label: self
                    .assignee
                    .as_ref()
                    .map(|value| value.display_name.clone())
                    .unwrap_or_else(|| "Unassigned".into()),
            }),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct StoredChange {
    pub change: PendingChange,
    pub transition_id: Option<String>,
    pub source_status_id: Option<String>,
    pub accepted: bool,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "field")]
pub(crate) enum ChangeRequest {
    #[serde(rename = "status")]
    Status {
        #[serde(rename = "transitionId")]
        transition_id: String,
    },
    #[serde(rename = "assignee")]
    Assignee {
        #[serde(rename = "accountId")]
        account_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityTransition {
    pub id: String,
    pub name: String,
    pub target: IssueStatus,
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueCapabilities {
    pub source_status_id: String,
    pub transitions_captured_at: Option<String>,
    pub assignees_captured_at: Option<String>,
    pub transitions: Vec<CapabilityTransition>,
    pub assignees: Vec<Assignee>,
    pub can_assign: bool,
    pub assignee_query: String,
    pub assignees_complete: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangeEvent {
    pub owner: Owner,
    pub revision: i64,
    pub issue_id: Option<String>,
}
