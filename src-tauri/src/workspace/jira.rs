use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use futures_util::{stream, StreamExt, TryStreamExt};
use reqwest::{header, Client, StatusCode};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::time::Instant;
use url::Url;

use super::model::{
    Assignee, Attachment, CachedIssue, CachedWorkspace, Column, Comment, IssueDetail, IssueStatus,
    IssueSummary, Membership, Snapshot, Sprint, WorkspaceRef,
};
use crate::{auth_header, client, is_redirect, should_fetch_next, AppError, Connection, Result};

const REMOTE_PAGE: usize = 100;
const MAX_PAGES: usize = 10_000;
const DETAIL_CONCURRENCY: usize = 6;

#[allow(async_fn_in_trait)]
pub(super) trait Api {
    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value>;
}

pub(super) struct HttpApi<'a> {
    connection: &'a Connection,
    client: Client,
}

static RATE_LIMIT_UNTIL: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
fn rate_limit_until() -> &'static Mutex<Option<Instant>> {
    RATE_LIMIT_UNTIL.get_or_init(|| Mutex::new(None))
}

fn retry_after(value: Option<&header::HeaderValue>) -> Duration {
    let value = value.and_then(|value| value.to_str().ok()).unwrap_or("");
    if let Ok(seconds) = value.parse::<u64>() {
        return Duration::from_secs(seconds.max(1));
    }
    if let Ok(date) = chrono::DateTime::parse_from_rfc2822(value) {
        let remaining = date.signed_duration_since(chrono::Utc::now());
        return remaining
            .to_std()
            .unwrap_or(Duration::from_secs(1))
            .max(Duration::from_secs(1));
    }
    Duration::from_secs(60)
}

impl<'a> HttpApi<'a> {
    pub fn new(connection: &'a Connection) -> Result<Self> {
        Ok(Self {
            connection,
            client: client()?,
        })
    }
}

#[derive(Debug)]
pub(super) enum WriteFailure {
    Rejected { status: u16, message: String },
    Deferred,
    Unknown,
}

impl HttpApi<'_> {
    fn cooling_down(&self) -> bool {
        rate_limit_until()
            .lock()
            .map(|until| until.is_some_and(|until| until > Instant::now()))
            .unwrap_or(true)
    }

    fn remember_limit(&self, response: &reqwest::Response) {
        let delay = retry_after(response.headers().get(header::RETRY_AFTER));
        if let Ok(mut cooldown) = rate_limit_until().lock() {
            *cooldown = Some(
                cooldown
                    .unwrap_or(Instant::now())
                    .max(Instant::now() + delay),
            );
        }
    }

    // Deliberately separate from GET: an ambiguous mutation is never retried here.
    pub(super) async fn write(
        &self,
        path: &str,
        method: reqwest::Method,
        body: Value,
    ) -> std::result::Result<(), WriteFailure> {
        if self.cooling_down() {
            return Err(WriteFailure::Deferred);
        }
        let response = self
            .client
            .request(
                method,
                format!("{}{}", self.connection.session.site_url, path),
            )
            .header(
                header::AUTHORIZATION,
                auth_header(&self.connection.session.email, &self.connection.token),
            )
            .header(header::ACCEPT, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|_| WriteFailure::Unknown)?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            self.remember_limit(&response);
            return Err(WriteFailure::Deferred);
        }
        if status.is_client_error() && status != StatusCode::REQUEST_TIMEOUT {
            let body: Value = response.json().await.unwrap_or(Value::Null);
            return Err(WriteFailure::Rejected {
                status: status.as_u16(),
                message: validation_message(&body),
            });
        }
        Err(WriteFailure::Unknown)
    }
}

fn validation_message(body: &Value) -> String {
    let messages = body
        .get("errorMessages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(
            body.get("errors")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|fields| fields.values())
                .filter_map(Value::as_str),
        )
        .take(3)
        .map(|message| message.chars().take(240).collect::<String>())
        .collect::<Vec<_>>();
    if messages.is_empty() {
        "Jira rejected this change. Check permissions and available issue actions.".into()
    } else {
        messages.join(" ")
    }
}

impl Api for HttpApi<'_> {
    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        if self.cooling_down() {
            return Err(AppError::RateLimited);
        }
        let mut url = Url::parse(&format!("{}{}", self.connection.session.site_url, path))
            .map_err(|_| AppError::Metadata)?;
        url.query_pairs_mut()
            .extend_pairs(query.iter().map(|(key, value)| (*key, value.as_str())));
        let response = self
            .client
            .get(url)
            .header(
                header::AUTHORIZATION,
                auth_header(&self.connection.session.email, &self.connection.token),
            )
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| AppError::Network)?;
        match response.status() {
            StatusCode::TOO_MANY_REQUESTS => {
                self.remember_limit(&response);
                Err(AppError::RateLimited)
            }
            StatusCode::UNAUTHORIZED => Err(AppError::Unauthorized),
            StatusCode::FORBIDDEN => Err(AppError::Forbidden),
            StatusCode::NOT_FOUND => Err(AppError::IssueUnavailable),
            status if is_redirect(status) => Err(AppError::Redirect),
            status if !status.is_success() => Err(AppError::Jira),
            _ => response.json().await.map_err(|_| AppError::Metadata),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OffsetPage<T> {
    values: Vec<T>,
    total: Option<usize>,
    is_last: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenIssues {
    issues: Vec<Value>,
    next_page_token: Option<String>,
    is_last: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentPage {
    comments: Vec<Value>,
    total: usize,
    start_at: Option<usize>,
}

#[derive(Clone)]
struct ScopeIssue {
    key: String,
    updated: Option<String>,
    updated_consistent: bool,
    sprint_ids: Vec<i64>,
}

pub(super) async fn fetch_snapshot<A: Api>(
    api: &A,
    project_key: &str,
    board_id: i64,
    previous: &HashMap<String, CachedIssue>,
    synced_at: String,
) -> Result<Snapshot> {
    let project = api
        .get(&format!("/rest/api/3/project/{project_key}"), &[])
        .await?;
    let project_name = required_str(&project, "/name")?.to_owned();
    if required_str(&project, "/key")? != project_key {
        return Err(AppError::Scope);
    }
    let board = api
        .get(&format!("/rest/agile/1.0/board/{board_id}"), &[])
        .await?;
    if required_str(&board, "/type")? != "scrum" {
        return Err(AppError::Scope);
    }
    let board_name = required_str(&board, "/name")?.to_owned();
    let config = api
        .get(
            &format!("/rest/agile/1.0/board/{board_id}/configuration"),
            &[],
        )
        .await?;
    let columns = board_columns(&config)?;
    let estimation_field = config
        .pointer("/estimation/field/fieldId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let statuses = api.get("/rest/api/3/status", &[]).await?;
    if !statuses.is_array() {
        return Err(AppError::Metadata);
    }
    let versions = api
        .get(&format!("/rest/api/3/project/{project_key}/versions"), &[])
        .await?;
    if !versions.is_array() {
        return Err(AppError::Metadata);
    }
    let sprints = fetch_sprints(api, board_id).await?;

    let sprint_ids = sprints.iter().map(|sprint| sprint.id).collect::<Vec<_>>();
    let project_jql = format!("project = {project_key}");
    let nondone_jql = format!("{project_jql} AND statusCategory != Done");
    let membership_jql = if sprint_ids.is_empty() {
        nondone_jql.clone()
    } else {
        format!(
            "{project_jql} AND (statusCategory != Done OR sprint in ({}))",
            sprint_ids
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let board_issues = fetch_token_issues(
        api,
        &format!("/rest/software/1.0/board/{board_id}/issue"),
        &[("jql", membership_jql)],
    )
    .await?;
    let board_ids = board_issues
        .iter()
        .map(|issue| source_issue(issue, project_key))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .map(|(id, _, _)| id)
        .collect::<HashSet<_>>();

    let mut scope: HashMap<String, ScopeIssue> = HashMap::new();
    let mut order = Vec::new();
    let mut memberships = Vec::new();
    let mut seen_memberships = HashSet::new();
    let mut current_rank = 0;
    let mut future_rank = 0;
    let mut backlog_rank = 0;
    for sprint in &sprints {
        let sprint_issues = fetch_token_issues(
            api,
            &format!("/rest/software/1.0/sprint/{}/issue", sprint.id),
            &[("jql", project_jql.clone())],
        )
        .await?;
        for (index, issue) in sprint_issues.iter().enumerate() {
            let Some((id, key, updated)) = source_issue(issue, project_key)? else {
                continue;
            };
            insert_scope(&mut scope, &mut order, &id, key, updated);
            if !scope.get(&id).unwrap().sprint_ids.contains(&sprint.id) {
                scope.get_mut(&id).unwrap().sprint_ids.push(sprint.id);
            }
            let view = if sprint.state == "active" {
                "current"
            } else {
                "future"
            };
            add_membership(
                &mut memberships,
                &mut seen_memberships,
                view,
                sprint.id,
                &id,
                index as i64,
            );
            let aggregate_rank = if sprint.state == "active" {
                let rank = current_rank;
                current_rank += 1;
                rank
            } else {
                let rank = future_rank;
                future_rank += 1;
                rank
            };
            add_membership(
                &mut memberships,
                &mut seen_memberships,
                view,
                0,
                &id,
                aggregate_rank,
            );
        }
    }
    let backlog = fetch_token_issues(
        api,
        &format!("/rest/software/1.0/board/{board_id}/backlog"),
        &[("jql", project_jql.clone())],
    )
    .await?;
    for issue in &backlog {
        let Some((id, key, updated)) = source_issue(issue, project_key)? else {
            continue;
        };
        insert_scope(&mut scope, &mut order, &id, key, updated);
        add_membership(
            &mut memberships,
            &mut seen_memberships,
            "backlog",
            0,
            &id,
            backlog_rank,
        );
        backlog_rank += 1;
    }
    let candidates = fetch_token_issues(
        api,
        "/rest/api/3/search/jql",
        &[
            ("jql", format!("{nondone_jql} ORDER BY updated DESC")),
            ("fields", "project,updated".into()),
        ],
    )
    .await?;
    for issue in &candidates {
        let Some((id, key, updated)) = source_issue(issue, project_key)? else {
            continue;
        };
        insert_scope(&mut scope, &mut order, &id, key, updated);
    }

    let work = order
        .iter()
        .enumerate()
        .map(|(rank, id)| {
            (
                rank,
                id.clone(),
                scope.get(id).unwrap().clone(),
                previous.get(id).cloned(),
            )
        })
        .collect::<Vec<_>>();
    let loaded = stream::iter(work.into_iter().map(|(rank, id, source, old)| {
        let board_ids = &board_ids;
        let estimation_field = estimation_field.as_deref();
        async move {
            let off_board = !board_ids.contains(&id);
            let mut cached = if source.updated_consistent
                && source.updated.as_deref().is_some_and(|updated| {
                    old.as_ref().is_some_and(|old| {
                        old.summary.updated == updated && old.summary.key == source.key
                    })
                }) {
                old.unwrap()
            } else {
                let raw = api
                    .get(
                        &format!("/rest/api/3/issue/{id}"),
                        &[("fields", "*all".into()), ("expand", "names".into())],
                    )
                    .await?;
                let comments = fetch_comments(api, &id).await?;
                let summary = normalize_summary(
                    &raw,
                    estimation_field,
                    &source.sprint_ids,
                    off_board,
                    project_key,
                )?;
                let detail = normalize_detail(&raw, summary.clone(), comments)?;
                CachedIssue {
                    summary,
                    detail,
                    rank: rank as i64,
                }
            };
            cached.rank = rank as i64;
            cached.summary.off_board = off_board;
            cached.summary.sprint_ids = source.sprint_ids.clone();
            cached.detail.issue = cached.summary.clone();
            Ok::<_, AppError>(cached)
        }
    }))
    .buffer_unordered(DETAIL_CONCURRENCY)
    .try_collect::<Vec<_>>()
    .await?;
    let mut issues = loaded;
    issues.sort_by_key(|issue| issue.rank);
    let comment_count = issues.iter().map(|issue| issue.detail.comments.len()).sum();
    let issue_count = issues.len();
    Ok(Snapshot {
        workspace: CachedWorkspace {
            reference: WorkspaceRef {
                project_key: project_key.into(),
                board_id,
                project_name,
                board_name,
                last_synced_at: synced_at,
            },
            columns,
            sprints,
            issue_count,
            comment_count,
        },
        support: json!({"boardConfig":config,"statuses":statuses,"versions":versions,"project":project,"board":board}),
        issues,
        memberships,
    })
}

fn required_str<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or(AppError::Metadata)
}
fn string_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|id| id.to_string()))
}

fn board_columns(config: &Value) -> Result<Vec<Column>> {
    let raw = config
        .pointer("/columnConfig/columns")
        .and_then(Value::as_array)
        .ok_or(AppError::Metadata)?;
    raw.iter()
        .map(|column| {
            let name = required_str(column, "/name")?.to_owned();
            let statuses = column
                .get("statuses")
                .and_then(Value::as_array)
                .ok_or(AppError::Metadata)?;
            let status_ids = statuses
                .iter()
                .map(|status| {
                    status
                        .get("id")
                        .and_then(string_id)
                        .ok_or(AppError::Metadata)
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(Column { name, status_ids })
        })
        .collect()
}

async fn fetch_sprints<A: Api>(api: &A, board_id: i64) -> Result<Vec<Sprint>> {
    let mut start = 0usize;
    let mut sprints = Vec::new();
    for _ in 0..MAX_PAGES {
        let raw = api
            .get(
                &format!("/rest/agile/1.0/board/{board_id}/sprint"),
                &[
                    ("state", "active,future".into()),
                    ("startAt", start.to_string()),
                    ("maxResults", REMOTE_PAGE.to_string()),
                ],
            )
            .await?;
        let page: OffsetPage<Value> =
            serde_json::from_value(raw).map_err(|_| AppError::Metadata)?;
        let next = should_fetch_next(page.total, page.is_last, start, page.values.len())?;
        start += page.values.len();
        for sprint in page.values {
            let state = required_str(&sprint, "/state")?;
            if state != "active" && state != "future" {
                continue;
            }
            let id = sprint
                .get("id")
                .and_then(Value::as_i64)
                .ok_or(AppError::Metadata)?;
            sprints.push(Sprint {
                id,
                name: required_str(&sprint, "/name")?.into(),
                state: state.into(),
                start_date: sprint
                    .get("startDate")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                end_date: sprint
                    .get("endDate")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                goal: sprint
                    .get("goal")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
        if !next {
            return Ok(sprints);
        }
    }
    Err(AppError::Metadata)
}

async fn fetch_token_issues<A: Api>(
    api: &A,
    path: &str,
    query: &[(&str, String)],
) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    let mut token: Option<String> = None;
    let mut used_tokens = HashSet::new();
    for _ in 0..MAX_PAGES {
        let mut params = query.to_vec();
        params.push(("maxResults", REMOTE_PAGE.to_string()));
        if let Some(current) = &token {
            params.push(("nextPageToken", current.clone()));
        }
        let raw = api.get(path, &params).await?;
        let page: TokenIssues = serde_json::from_value(raw).map_err(|_| AppError::Metadata)?;
        let next = page.next_page_token.filter(|token| !token.is_empty());
        if page.issues.is_empty() && (page.is_last == Some(false) || next.is_some()) {
            return Err(AppError::Metadata);
        }
        result.extend(page.issues);
        if page.is_last == Some(true) || (page.is_last.is_none() && next.is_none()) {
            return Ok(result);
        }
        let next = next.ok_or(AppError::Metadata)?;
        if !used_tokens.insert(next.clone()) {
            return Err(AppError::Metadata);
        }
        token = Some(next);
    }
    Err(AppError::Metadata)
}

async fn fetch_comments<A: Api>(api: &A, issue_id: &str) -> Result<Vec<Comment>> {
    let mut start = 0usize;
    let mut comments = Vec::new();
    let mut ids = HashSet::new();
    for _ in 0..MAX_PAGES {
        let raw = api
            .get(
                &format!("/rest/api/3/issue/{issue_id}/comment"),
                &[
                    ("startAt", start.to_string()),
                    ("maxResults", REMOTE_PAGE.to_string()),
                    ("orderBy", "created".into()),
                ],
            )
            .await?;
        let page: CommentPage = serde_json::from_value(raw).map_err(|_| AppError::Metadata)?;
        if page.start_at.is_some_and(|returned| returned != start) {
            return Err(AppError::Metadata);
        }
        let next = should_fetch_next(Some(page.total), None, start, page.comments.len())?;
        start += page.comments.len();
        for raw_comment in page.comments {
            let id = raw_comment
                .get("id")
                .and_then(string_id)
                .ok_or(AppError::Metadata)?;
            if !ids.insert(id.clone()) {
                return Err(AppError::Metadata);
            }
            comments.push(Comment {
                id,
                author: required_str(&raw_comment, "/author/displayName")?.into(),
                created: required_str(&raw_comment, "/created")?.into(),
                updated: required_str(&raw_comment, "/updated")?.into(),
                body: raw_comment.get("body").cloned().ok_or(AppError::Metadata)?,
            });
        }
        if !next {
            return Ok(comments);
        }
    }
    Err(AppError::Metadata)
}

fn source_issue(
    raw: &Value,
    project_key: &str,
) -> Result<Option<(String, String, Option<String>)>> {
    let actual = required_str(raw, "/fields/project/key")?;
    if actual != project_key {
        return Ok(None);
    }
    let id = raw
        .get("id")
        .and_then(string_id)
        .ok_or(AppError::Metadata)?;
    let key = required_str(raw, "/key")?.to_owned();
    let updated = raw
        .pointer("/fields/updated")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(Some((id, key, updated)))
}

fn insert_scope(
    scope: &mut HashMap<String, ScopeIssue>,
    order: &mut Vec<String>,
    id: &str,
    key: String,
    updated: Option<String>,
) {
    if let Some(existing) = scope.get_mut(id) {
        existing.key = key;
        if let Some(updated) = updated {
            if existing.updated.as_ref().is_some_and(|old| old != &updated) {
                existing.updated_consistent = false;
            }
            if existing.updated.is_none() {
                existing.updated = Some(updated);
            }
        }
    } else {
        order.push(id.into());
        scope.insert(
            id.into(),
            ScopeIssue {
                key,
                updated,
                updated_consistent: true,
                sprint_ids: Vec::new(),
            },
        );
    }
}

fn add_membership(
    memberships: &mut Vec<Membership>,
    seen: &mut HashSet<(&'static str, i64, String)>,
    view: &'static str,
    sprint_id: i64,
    issue_id: &str,
    rank: i64,
) {
    if seen.insert((view, sprint_id, issue_id.into())) {
        memberships.push(Membership {
            view,
            sprint_id,
            issue_id: issue_id.into(),
            rank,
        });
    }
}

fn normalize_summary(
    raw: &Value,
    estimation_field: Option<&str>,
    sprint_ids: &[i64],
    off_board: bool,
    project_key: &str,
) -> Result<IssueSummary> {
    if required_str(raw, "/fields/project/key")? != project_key {
        return Err(AppError::Scope);
    }
    let fields = raw
        .get("fields")
        .and_then(Value::as_object)
        .ok_or(AppError::Metadata)?;
    let id = raw
        .get("id")
        .and_then(string_id)
        .ok_or(AppError::Metadata)?;
    let key = required_str(raw, "/key")?.to_owned();
    let status = fields.get("status").ok_or(AppError::Metadata)?;
    let category = status
        .pointer("/statusCategory/key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let assignee = fields
        .get("assignee")
        .filter(|value| !value.is_null())
        .map(|value| {
            Ok(Assignee {
                id: required_str(value, "/accountId")?.into(),
                display_name: required_str(value, "/displayName")?.into(),
            })
        })
        .transpose()?;
    let versions = fields
        .get("fixVersions")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|version| {
                    version
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default();
    let epic = fields
        .get("epic")
        .and_then(|value| {
            value
                .get("key")
                .and_then(Value::as_str)
                .or_else(|| value.as_str())
        })
        .map(str::to_owned)
        .or_else(|| {
            fields.get("parent").and_then(|parent| {
                let kind = parent
                    .pointer("/fields/issuetype/name")
                    .and_then(Value::as_str);
                let level = parent
                    .pointer("/fields/issuetype/hierarchyLevel")
                    .and_then(Value::as_i64);
                if kind == Some("Epic") || level == Some(1) {
                    parent.get("key").and_then(Value::as_str).map(str::to_owned)
                } else {
                    None
                }
            })
        });
    Ok(IssueSummary {
        id,
        key,
        summary: required_str(raw, "/fields/summary")?.into(),
        status: IssueStatus {
            id: status
                .get("id")
                .and_then(string_id)
                .ok_or(AppError::Metadata)?,
            name: required_str(status, "/name")?.into(),
            category,
        },
        assignee,
        issue_type: required_str(raw, "/fields/issuetype/name")?.into(),
        priority: fields
            .get("priority")
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        story_points: estimation_field
            .and_then(|id| fields.get(id))
            .and_then(Value::as_f64),
        versions,
        sprint_ids: sprint_ids.to_vec(),
        epic,
        updated: required_str(raw, "/fields/updated")?.into(),
        off_board,
    })
}

fn normalize_detail(
    raw: &Value,
    summary: IssueSummary,
    comments: Vec<Comment>,
) -> Result<IssueDetail> {
    let fields = raw
        .get("fields")
        .and_then(Value::as_object)
        .ok_or(AppError::Metadata)?
        .clone();
    let names = raw
        .get("names")
        .and_then(Value::as_object)
        .ok_or(AppError::Metadata)?;
    let field_names: Map<String, Value> = names
        .iter()
        .map(|(id, name)| {
            name.as_str()
                .map(|name| (id.clone(), Value::String(name.into())))
                .ok_or(AppError::Metadata)
        })
        .collect::<Result<_>>()?;
    let attachments = fields
        .get("attachment")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    Ok(Attachment {
                        id: value
                            .get("id")
                            .and_then(string_id)
                            .ok_or(AppError::Metadata)?,
                        filename: required_str(value, "/filename")?.into(),
                        mime_type: required_str(value, "/mimeType")?.into(),
                        size: value
                            .get("size")
                            .and_then(Value::as_i64)
                            .ok_or(AppError::Metadata)?,
                    })
                })
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(IssueDetail {
        issue: summary,
        description: fields.get("description").cloned().unwrap_or(Value::Null),
        fields,
        field_names,
        comments,
        attachments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    struct StubApi {
        routes: HashMap<String, Value>,
        calls: StdMutex<Vec<String>>,
    }
    impl StubApi {
        fn new() -> Self {
            Self {
                routes: HashMap::new(),
                calls: StdMutex::new(Vec::new()),
            }
        }
        fn add(&mut self, path: &str, query: &[(&str, String)], value: Value) {
            self.routes.insert(route(path, query), value);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }
    fn route(path: &str, query: &[(&str, String)]) -> String {
        let mut pairs = query
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>();
        pairs.sort();
        format!("{path}?{}", pairs.join("&"))
    }
    impl Api for StubApi {
        async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
            let key = route(path, query);
            self.calls.lock().unwrap().push(key.clone());
            self.routes.get(&key).cloned().ok_or(AppError::Metadata)
        }
    }
    fn listed(id: &str, category: &str) -> Value {
        json!({"id":id,"key":format!("CK-{id}"),"fields":{"project":{"key":"CK"},"updated":"2026-09-27T10:00:00.000+0000","status":{"statusCategory":{"key":category}}}})
    }
    fn detail() -> Value {
        json!({"id":"1","key":"CK-1","names":{"customfield_9":"Opaque integration field"},"fields":{
            "project":{"key":"CK"},"updated":"2026-09-27T10:00:00.000+0000","summary":"Completed work","status":{"id":"42","name":"Done","statusCategory":{"key":"done"}},
            "issuetype":{"name":"Task"},"assignee":null,"priority":null,"fixVersions":[{"name":"ck-admin-4.44.0"}],"customfield_31":3,
            "description":{"type":"doc","version":1,"content":[{"type":"unknownNode","attrs":{"opaque":true}}]},"customfield_9":{"nested":{"keep":true}},"attachment":[]
        }})
    }
    fn base_api() -> StubApi {
        let mut api = StubApi::new();
        api.add(
            "/rest/api/3/project/CK",
            &[],
            json!({"key":"CK","name":"CargoKing"}),
        );
        api.add(
            "/rest/agile/1.0/board/7",
            &[],
            json!({"id":7,"name":"Main","type":"scrum"}),
        );
        api.add("/rest/agile/1.0/board/7/configuration",&[],json!({"columnConfig":{"columns":[{"name":"Done","statuses":[{"id":"42"}]}]},"estimation":{"type":"field","field":{"fieldId":"customfield_31"}}}));
        api.add(
            "/rest/api/3/status",
            &[],
            json!([{"id":"42","name":"Done"}]),
        );
        api.add(
            "/rest/api/3/project/CK/versions",
            &[],
            json!([{"id":"9","name":"ck-admin-4.44.0"}]),
        );
        api.add(
            "/rest/agile/1.0/board/7/sprint",
            &[
                ("state", "active,future".into()),
                ("startAt", "0".into()),
                ("maxResults", "100".into()),
            ],
            json!({"values":[{"id":11,"name":"Current","state":"active"}],"total":1,"isLast":true}),
        );
        api.add(
            "/rest/software/1.0/board/7/issue",
            &[
                (
                    "jql",
                    "project = CK AND (statusCategory != Done OR sprint in (11))".into(),
                ),
                ("maxResults", "100".into()),
            ],
            json!({"issues":[],"isLast":true}),
        );
        api.add(
            "/rest/software/1.0/sprint/11/issue",
            &[("jql", "project = CK".into()), ("maxResults", "100".into())],
            json!({"issues":[listed("1","done")],"isLast":true}),
        );
        api.add(
            "/rest/software/1.0/board/7/backlog",
            &[("jql", "project = CK".into()), ("maxResults", "100".into())],
            json!({"issues":[],"isLast":true}),
        );
        api.add(
            "/rest/api/3/search/jql",
            &[
                (
                    "jql",
                    "project = CK AND statusCategory != Done ORDER BY updated DESC".into(),
                ),
                ("fields", "project,updated".into()),
                ("maxResults", "100".into()),
            ],
            json!({"issues":[],"isLast":true}),
        );
        api
    }
    fn comments(api: &mut StubApi) {
        api.add("/rest/api/3/issue/1/comment",&[("startAt","0".into()),("maxResults","100".into()),("orderBy","created".into())],json!({"startAt":0,"total":2,"comments":[{"id":"c1","author":{"displayName":"Yi"},"created":"t1","updated":"t1","body":{"type":"doc","version":1,"content":[]}}]}));
        api.add("/rest/api/3/issue/1/comment",&[("startAt","1".into()),("maxResults","100".into()),("orderBy","created".into())],json!({"startAt":1,"total":2,"comments":[{"id":"c2","author":{"displayName":"Teammate"},"created":"t2","updated":"t2","body":{"type":"doc","version":1,"content":[]}}]}));
    }
    #[tokio::test]
    async fn token_and_offset_pages_use_their_distinct_raw_response_shapes() {
        let mut api = StubApi::new();
        let sprint_path = "/rest/agile/1.0/board/7/sprint";
        api.add(
            sprint_path,
            &[
                ("state", "active,future".into()),
                ("startAt", "0".into()),
                ("maxResults", "100".into()),
            ],
            json!({"values":[{"id":11,"name":"A","state":"active"}],"total":2,"isLast":false}),
        );
        api.add(
            sprint_path,
            &[
                ("state", "active,future".into()),
                ("startAt", "1".into()),
                ("maxResults", "100".into()),
            ],
            json!({"values":[{"id":12,"name":"F","state":"future"}],"total":2,"isLast":true}),
        );
        assert_eq!(fetch_sprints(&api, 7).await.unwrap().len(), 2);
        let issue_path = "/rest/software/1.0/board/7/backlog";
        api.add(
            issue_path,
            &[("maxResults", "100".into())],
            json!({"issues":[listed("1","new")],"nextPageToken":"next-1","isLast":false}),
        );
        api.add(
            issue_path,
            &[
                ("maxResults", "100".into()),
                ("nextPageToken", "next-1".into()),
            ],
            json!({"issues":[listed("2","new")],"isLast":true}),
        );
        assert_eq!(
            fetch_token_issues(&api, issue_path, &[])
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(api.calls().len(), 4);
    }
    #[tokio::test]
    async fn completed_current_sprint_issue_and_all_comments_survive_normalization() {
        let mut api = base_api();
        api.add(
            "/rest/api/3/issue/1",
            &[("fields", "*all".into()), ("expand", "names".into())],
            detail(),
        );
        comments(&mut api);
        let snapshot = fetch_snapshot(
            &api,
            "CK",
            7,
            &HashMap::new(),
            "2026-09-27T11:00:00Z".into(),
        )
        .await
        .unwrap();
        assert_eq!(snapshot.workspace.issue_count, 1);
        assert_eq!(snapshot.workspace.comment_count, 2);
        assert_eq!(snapshot.issues[0].summary.status.category, "done");
        assert!(snapshot.issues[0].summary.off_board);
        assert_eq!(snapshot.issues[0].summary.sprint_ids, [11]);
        assert_eq!(snapshot.issues[0].summary.story_points, Some(3.0));
        assert_eq!(
            snapshot.issues[0].detail.fields["customfield_9"]["nested"]["keep"],
            true
        );
        assert_eq!(
            snapshot.issues[0].detail.description["content"][0]["type"],
            "unknownNode"
        );
        assert!(snapshot
            .memberships
            .iter()
            .any(|m| m.view == "current" && m.sprint_id == 11 && m.issue_id == "1"));
        assert!(!snapshot
            .memberships
            .iter()
            .any(|m| m.view == "backlog" && m.issue_id == "1"));
    }
    #[tokio::test]
    async fn warm_sync_reuses_unchanged_detail_and_comments() {
        let mut initial = base_api();
        initial.add(
            "/rest/api/3/issue/1",
            &[("fields", "*all".into()), ("expand", "names".into())],
            detail(),
        );
        comments(&mut initial);
        let first = fetch_snapshot(&initial, "CK", 7, &HashMap::new(), "t1".into())
            .await
            .unwrap();
        let previous = HashMap::from([("1".into(), first.issues[0].clone())]);
        let warm = base_api();
        let second = fetch_snapshot(&warm, "CK", 7, &previous, "t2".into())
            .await
            .unwrap();
        assert_eq!(second.workspace.comment_count, 2);
        assert!(!warm
            .calls()
            .iter()
            .any(|call| call.starts_with("/rest/api/3/issue/1?")));
    }
    #[tokio::test]
    async fn incomplete_comment_page_fails_the_snapshot() {
        let mut api = base_api();
        api.add(
            "/rest/api/3/issue/1",
            &[("fields", "*all".into()), ("expand", "names".into())],
            detail(),
        );
        api.add(
            "/rest/api/3/issue/1/comment",
            &[
                ("startAt", "0".into()),
                ("maxResults", "100".into()),
                ("orderBy", "created".into()),
            ],
            json!({"startAt":0,"total":2,"comments":[]}),
        );
        assert!(matches!(
            fetch_snapshot(&api, "CK", 7, &HashMap::new(), "t".into()).await,
            Err(AppError::Metadata)
        ));
    }

    #[tokio::test]
    async fn enhanced_search_requests_fields_instead_of_receiving_ids_only() {
        let mut api = base_api();
        let search = "/rest/api/3/search/jql";
        let query = [
            (
                "jql",
                "project = CK AND statusCategory != Done ORDER BY updated DESC".into(),
            ),
            ("maxResults", "100".into()),
        ];
        // Enhanced search defaults to IDs only, unlike the Agile issue endpoints.
        api.add(search, &query, json!({"issues":[{"id":"1"}],"isLast":true}));
        let mut with_fields = query.to_vec();
        with_fields.push(("fields", "project,updated".into()));
        api.add(
            search,
            &with_fields,
            json!({"issues":[listed("1","new")],"isLast":true}),
        );
        api.add(
            "/rest/api/3/issue/1",
            &[("fields", "*all".into()), ("expand", "names".into())],
            detail(),
        );
        comments(&mut api);
        let snapshot = fetch_snapshot(&api, "CK", 7, &HashMap::new(), "t".into())
            .await
            .unwrap();
        assert_eq!(snapshot.workspace.issue_count, 1);
        assert_eq!(snapshot.issues[0].summary.key, "CK-1");
        assert_eq!(snapshot.workspace.comment_count, 2);
    }

    #[tokio::test]
    async fn project_candidate_overlap_is_deduplicated_and_board_membership_is_authoritative() {
        let mut api = base_api();
        api.add(
            "/rest/software/1.0/sprint/11/issue",
            &[("jql", "project = CK".into()), ("maxResults", "100".into())],
            json!({"issues":[listed("1","new")],"isLast":true}),
        );
        api.add(
            "/rest/api/3/search/jql",
            &[
                (
                    "jql",
                    "project = CK AND statusCategory != Done ORDER BY updated DESC".into(),
                ),
                ("fields", "project,updated".into()),
                ("maxResults", "100".into()),
            ],
            json!({"issues":[listed("1","new")],"isLast":true}),
        );
        api.add(
            "/rest/software/1.0/board/7/issue",
            &[
                (
                    "jql",
                    "project = CK AND (statusCategory != Done OR sprint in (11))".into(),
                ),
                ("maxResults", "100".into()),
            ],
            json!({"issues":[listed("1","new")],"isLast":true}),
        );
        api.add(
            "/rest/api/3/issue/1",
            &[("fields", "*all".into()), ("expand", "names".into())],
            detail(),
        );
        comments(&mut api);
        let snapshot = fetch_snapshot(&api, "CK", 7, &HashMap::new(), "t".into())
            .await
            .unwrap();
        assert_eq!(snapshot.workspace.issue_count, 1);
        assert!(!snapshot.issues[0].summary.off_board);
        assert_eq!(
            snapshot
                .memberships
                .iter()
                .filter(|m| m.view == "current" && m.sprint_id == 11)
                .count(),
            1
        );
    }

    #[test]
    fn retry_after_120_seconds_is_not_shortened() {
        let value = header::HeaderValue::from_static("120");
        assert_eq!(retry_after(Some(&value)), Duration::from_secs(120));
        let future = (chrono::Utc::now() + chrono::Duration::minutes(2)).to_rfc2822();
        let value = header::HeaderValue::from_str(&future).unwrap();
        assert!(retry_after(Some(&value)) >= Duration::from_secs(118));
    }
}
