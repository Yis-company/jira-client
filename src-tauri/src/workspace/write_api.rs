use serde_json::{json, Value};

use super::{
    jira::{Api, HttpApi, WriteFailure},
    model::{
        Assignee, CapabilityTransition, IssueCapabilities, IssueStatus, RemoteFields, Sprint,
        StoredChange,
    },
};
use crate::{AppError, Result};

#[allow(async_fn_in_trait)]
pub(super) trait WriteApi: Api {
    async fn send_change(&self, change: &StoredChange) -> std::result::Result<(), WriteFailure>;
}

impl WriteApi for HttpApi<'_> {
    async fn send_change(&self, record: &StoredChange) -> std::result::Result<(), WriteFailure> {
        let path = format!("/rest/api/3/issue/{}", record.change.issue_id);
        match record.change.field.as_str() {
            "status" => {
                self.write(
                    &format!("{path}/transitions"),
                    reqwest::Method::POST,
                    json!({"transition":{"id":record.transition_id}}),
                )
                .await
            }
            "assignee" => {
                self.write(
                    &format!("{path}/assignee"),
                    reqwest::Method::PUT,
                    json!({"accountId":record.change.requested.id}),
                )
                .await
            }
            "summary" => {
                let value = record.change.requested.value.clone().ok_or_else(|| {
                    WriteFailure::Rejected {
                        status: 400,
                        message: "Missing title value.".into(),
                    }
                })?;
                self.write(
                    &path,
                    reqwest::Method::PUT,
                    json!({"fields":{"summary":value}}),
                )
                .await
            }
            "description" => {
                let value = record.change.requested.value.clone().ok_or_else(|| {
                    WriteFailure::Rejected {
                        status: 400,
                        message: "Missing description value.".into(),
                    }
                })?;
                self.write(
                    &path,
                    reqwest::Method::PUT,
                    json!({"fields":{"description":value}}),
                )
                .await
            }
            "sprint" => {
                let Some(target) = record.target_sprint_id else {
                    return Err(WriteFailure::Rejected {
                        status: 400,
                        message: "Missing destination sprint.".into(),
                    });
                };
                self.write(
                    &format!("/rest/agile/1.0/sprint/{target}/issue"),
                    reqwest::Method::POST,
                    json!({"issues":[record.change.issue_key]}),
                )
                .await
            }
            _ => Err(WriteFailure::Rejected {
                status: 400,
                message: "Unsupported field.".into(),
            }),
        }
    }
}

fn text<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or(AppError::Metadata)
}

pub(super) async fn remote_issue<A: Api>(api: &A, issue_id: &str) -> Result<RemoteFields> {
    remote_issue_with_sprints(api, issue_id, false).await
}

pub(super) async fn remote_issue_with_sprints<A: Api>(
    api: &A,
    issue_id: &str,
    include_sprints: bool,
) -> Result<RemoteFields> {
    let raw = api
        .get(
            &format!("/rest/api/3/issue/{issue_id}"),
            &[(
                "fields",
                "status,assignee,summary,description,updated,project".into(),
            )],
        )
        .await?;
    let id = text(&raw, "/id")?;
    if id != issue_id {
        return Err(AppError::Scope);
    }
    let assignee = match raw.pointer("/fields/assignee") {
        Some(Value::Null) => None,
        Some(user) => Some(Assignee {
            id: text(user, "/accountId")?.into(),
            display_name: text(user, "/displayName")?.into(),
        }),
        None => return Err(AppError::Metadata),
    };
    let mut sprint_ids = Vec::new();
    let mut open_sprint_ids = Vec::new();
    if include_sprints {
        let agile = api
            .get(&format!("/rest/agile/1.0/issue/{issue_id}"), &[])
            .await?;
        if text(&agile, "/id")? != issue_id || text(&agile, "/key")? != text(&raw, "/key")? {
            return Err(AppError::Scope);
        }
        let agile_fields = agile
            .get("fields")
            .and_then(Value::as_object)
            .ok_or(AppError::Metadata)?;
        let current_sprint = agile_fields.get("sprint").ok_or(AppError::Metadata)?;
        if !current_sprint.is_null() {
            let id = current_sprint
                .get("id")
                .and_then(Value::as_i64)
                .ok_or(AppError::Metadata)?;
            sprint_ids.push(id);
            open_sprint_ids.push(id);
        }
        let closed_sprints = agile_fields
            .get("closedSprints")
            .and_then(Value::as_array)
            .ok_or(AppError::Metadata)?;
        for sprint in closed_sprints {
            let id = sprint
                .get("id")
                .and_then(Value::as_i64)
                .ok_or(AppError::Metadata)?;
            if !sprint_ids.contains(&id) {
                sprint_ids.push(id);
            }
        }
    }
    let summary = text(&raw, "/fields/summary")?.to_owned();
    let description = raw
        .pointer("/fields/description")
        .cloned()
        .ok_or(AppError::Metadata)?;
    Ok(RemoteFields {
        issue_id: id.into(),
        key: text(&raw, "/key")?.into(),
        project_key: text(&raw, "/fields/project/key")?.into(),
        status: parse_status(raw.pointer("/fields/status").ok_or(AppError::Metadata)?)?,
        assignee,
        summary: Some(summary),
        description: Some(description),
        sprint_ids,
        open_sprint_ids,
        updated: text(&raw, "/fields/updated")?.into(),
    })
}

fn parse_status(raw: &Value) -> Result<IssueStatus> {
    Ok(IssueStatus {
        id: text(raw, "/id")?.into(),
        name: text(raw, "/name")?.into(),
        category: text(raw, "/statusCategory/key")?.into(),
    })
}

async fn transitions<A: Api>(api: &A, issue_id: &str) -> Result<Vec<CapabilityTransition>> {
    let raw = api
        .get(
            &format!("/rest/api/3/issue/{issue_id}/transitions"),
            &[("expand", "transitions.fields".into())],
        )
        .await?;
    raw.get("transitions").and_then(Value::as_array).ok_or(AppError::Metadata)?.iter().map(|entry| {
        // Missing expanded metadata is unknown, never permission to omit required fields.
        let fields = entry.get("fields").and_then(Value::as_object);
        let supported = fields.is_some_and(|fields| fields.values().all(|field| field.get("required").and_then(Value::as_bool) == Some(false)));
        Ok(CapabilityTransition {
            id: text(entry, "/id")?.into(), name: text(entry, "/name")?.into(),
            target: parse_status(entry.get("to").ok_or(AppError::Metadata)?)?, supported,
            reason: (!supported).then(|| "This transition requires additional field input or its field requirements are unavailable.".into()),
        })
    }).collect()
}

async fn can_assign<A: Api>(api: &A, issue_id: &str) -> Result<bool> {
    let raw = match api
        .get(
            "/rest/api/3/mypermissions",
            &[
                ("issueId", issue_id.into()),
                ("permissions", "ASSIGN_ISSUES".into()),
            ],
        )
        .await
    {
        Ok(raw) => raw,
        Err(AppError::Forbidden) => return Ok(false),
        Err(error) => return Err(error),
    };
    raw.pointer("/permissions/ASSIGN_ISSUES/havePermission")
        .and_then(Value::as_bool)
        .ok_or(AppError::Metadata)
}

async fn edit_fields<A: Api>(api: &A, issue_id: &str) -> Result<Value> {
    match api
        .get(&format!("/rest/api/3/issue/{issue_id}/editmeta"), &[])
        .await
    {
        Ok(value) => Ok(value
            .get("fields")
            .cloned()
            .filter(Value::is_object)
            .ok_or(AppError::Metadata)?),
        Err(AppError::Forbidden) => Ok(Value::Object(Default::default())),
        Err(error) => Err(error),
    }
}

fn can_unassign(edit_fields: &Value) -> bool {
    let Some(field) = edit_fields.get("assignee") else {
        return false;
    };
    field.get("required").and_then(Value::as_bool) == Some(false)
        && field
            .get("operations")
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some("set")))
}

async fn assignees<A: Api>(api: &A, key: &str, filter: (&str, String)) -> Result<Vec<Assignee>> {
    let raw = api
        .get(
            "/rest/api/3/user/assignable/search",
            &[
                ("issueKey", key.into()),
                filter,
                ("startAt", "0".into()),
                ("maxResults", "50".into()),
            ],
        )
        .await?;
    raw.as_array()
        .ok_or(AppError::Metadata)?
        .iter()
        .filter(|user| user.get("active").and_then(Value::as_bool) == Some(true))
        .map(|user| {
            Ok(Assignee {
                id: text(user, "/accountId")?.into(),
                display_name: text(user, "/displayName")?.into(),
            })
        })
        .collect()
}

pub(super) async fn capabilities<A: Api>(
    api: &A,
    remote: &RemoteFields,
    query: &str,
) -> Result<IssueCapabilities> {
    let transitions = transitions(api, &remote.issue_id).await?;
    let can_assign = can_assign(api, &remote.issue_id).await?;
    let edit_fields = edit_fields(api, &remote.issue_id).await?;
    let can_edit_summary = can_set(&edit_fields, "summary");
    let can_edit_description = can_set(&edit_fields, "description");
    let can_unassign = can_assign && can_unassign(&edit_fields);
    let assignees = if can_assign {
        assignees(api, &remote.key, ("query", query.into())).await?
    } else {
        vec![]
    };
    let now = chrono::Utc::now().to_rfc3339();
    let edit_capabilities_at = Some(now.clone());
    Ok(IssueCapabilities {
        source_status_id: remote.status.id.clone(),
        transitions_captured_at: Some(now.clone()),
        assignees_captured_at: Some(now),
        transitions,
        assignees,
        can_assign,
        can_unassign,
        can_edit_summary,
        can_edit_description,
        edit_capabilities_at,
        assignee_query: query.into(),
        assignees_complete: false,
    })
}

fn can_set(fields: &Value, key: &str) -> bool {
    fields
        .get(key)
        .and_then(|field| field.get("operations"))
        .and_then(Value::as_array)
        .is_some_and(|operations| {
            operations
                .iter()
                .any(|operation| operation.as_str() == Some("set"))
        })
}

pub(super) async fn validate<A: Api>(
    api: &A,
    record: &StoredChange,
    remote: &RemoteFields,
) -> Result<()> {
    if remote.issue_id != record.change.issue_id || remote.project_key != record.change.project_key
    {
        return Err(AppError::Scope);
    }
    match record.change.field.as_str() {
        "status" => {
            let available = transitions(api, &remote.issue_id).await?;
            if available.iter().any(|transition| {
                transition.supported
                    && Some(&transition.id) == record.transition_id.as_ref()
                    && Some(&transition.target.id) == record.change.requested.id.as_ref()
            }) {
                Ok(())
            } else {
                Err(AppError::InvalidChange)
            }
        }
        "assignee" => {
            let target = record.change.requested.id.clone();
            if !can_assign(api, &remote.issue_id).await? {
                return Err(AppError::Forbidden);
            }
            if let Some(target) = target {
                let candidates = assignees(api, &remote.key, ("accountId", target.clone())).await?;
                if candidates.iter().any(|user| user.id == target) {
                    Ok(())
                } else {
                    Err(AppError::InvalidChange)
                }
            } else {
                let fields = edit_fields(api, &remote.issue_id).await?;
                if can_unassign(&fields) {
                    Ok(())
                } else {
                    Err(AppError::Forbidden)
                }
            }
        }
        "summary" => {
            let fields = edit_fields(api, &remote.issue_id).await?;
            if can_set(&fields, "summary") {
                Ok(())
            } else {
                Err(AppError::Forbidden)
            }
        }
        "description" => {
            let fields = edit_fields(api, &remote.issue_id).await?;
            if can_set(&fields, "description") {
                Ok(())
            } else {
                Err(AppError::Forbidden)
            }
        }
        "sprint" => {
            let source = record.source_sprint_id.ok_or(AppError::InvalidChange)?;
            let target = record.target_sprint_id.ok_or(AppError::InvalidChange)?;
            if remote.status.category == "done" || remote.status.category == "complete" {
                return Err(AppError::InvalidChange);
            }
            let board_sprints = board_sprints(api, record.change.board_id).await?;
            let source_state = board_sprints
                .iter()
                .find(|sprint| sprint.id == source)
                .map(|sprint| sprint.state.as_str());
            let target_state = board_sprints
                .iter()
                .find(|sprint| sprint.id == target)
                .map(|sprint| sprint.state.as_str());
            if source_state != Some("active")
                || target_state != Some("future")
                || remote.open_sprint_ids.as_slice() != [source]
            {
                return Err(AppError::InvalidChange);
            }
            Ok(())
        }
        _ => Err(AppError::InvalidChange),
    }
}

async fn board_sprints<A: Api>(api: &A, board_id: i64) -> Result<Vec<Sprint>> {
    let path = format!("/rest/agile/1.0/board/{board_id}/sprint");
    let mut start = 0usize;
    let mut all = Vec::new();
    loop {
        let raw = api
            .get(
                &path,
                &[
                    ("state", "active,future".into()),
                    ("startAt", start.to_string()),
                    ("maxResults", "100".into()),
                ],
            )
            .await?;
        let values = raw
            .get("values")
            .and_then(Value::as_array)
            .ok_or(AppError::Metadata)?;
        let page_len = values.len();
        if page_len == 0 && raw.get("isLast").and_then(Value::as_bool) != Some(true) {
            return Err(AppError::Metadata);
        }
        for sprint in values {
            all.push(Sprint {
                id: sprint
                    .get("id")
                    .and_then(Value::as_i64)
                    .ok_or(AppError::Metadata)?,
                name: text(sprint, "/name")?.into(),
                state: text(sprint, "/state")?.into(),
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
        start += page_len;
        if raw.get("isLast").and_then(Value::as_bool) == Some(true)
            || raw
                .get("total")
                .and_then(Value::as_u64)
                .is_some_and(|total| start >= total as usize)
        {
            return Ok(all);
        }
        if page_len < 100 {
            return Err(AppError::Metadata);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fixture {
        response: Value,
        calls: Mutex<Vec<(String, Vec<(String, String)>)>>,
    }
    impl Fixture {
        fn new(response: Value) -> Self {
            Self {
                response,
                calls: Mutex::new(vec![]),
            }
        }
    }
    impl Api for Fixture {
        async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
            self.calls.lock().unwrap().push((
                path.into(),
                query
                    .iter()
                    .map(|(k, v)| ((*k).into(), v.clone()))
                    .collect(),
            ));
            if path.starts_with("/rest/agile/1.0/issue/") {
                let issue_id = self
                    .response
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("10");
                let key = self
                    .response
                    .get("key")
                    .and_then(Value::as_str)
                    .unwrap_or("CK-10");
                return Ok(
                    json!({"id":issue_id,"key":key,"fields":{"sprint":null,"closedSprints":[]}}),
                );
            }
            Ok(self.response.clone())
        }
    }

    #[tokio::test]
    async fn transition_requirements_must_be_explicit_and_need_no_extra_input() {
        let target =
            json!({"id":"2","name":"In progress","statusCategory":{"key":"indeterminate"}});
        let api = Fixture::new(json!({"transitions":[
            {"id":"1","name":"Empty","to":target,"fields":{}},
            {"id":"2","name":"Optional","to":target,"fields":{"comment":{"required":false}}},
            {"id":"3","name":"Required","to":target,"fields":{"resolution":{"required":true}}},
            {"id":"4","name":"Missing","to":target},
            {"id":"5","name":"Unknown","to":target,"fields":{"resolution":{}}}
        ]}));
        let options = transitions(&api, "10").await.unwrap();
        assert_eq!(
            options
                .iter()
                .map(|item| item.supported)
                .collect::<Vec<_>>(),
            vec![true, true, false, false, false]
        );
        assert!(options[2..].iter().all(|item| item.reason.is_some()));
        assert_eq!(
            api.calls.lock().unwrap()[0].1,
            vec![("expand".into(), "transitions.fields".into())]
        );
    }

    #[tokio::test]
    async fn direct_read_uses_raw_jira_ids_and_explicit_fields() {
        let api = Fixture::new(json!({"id":"10","key":"CK-10","fields":{
            "project":{"key":"CK"},"updated":"2026-09-27T10:00:00Z","summary":"Title","description":null,
            "status":{"id":"1","name":"Ready","statusCategory":{"key":"new"}},
            "assignee":{"accountId":"account-1","displayName":"Yi"}
        }}));
        let remote = remote_issue(&api, "10").await.unwrap();
        assert_eq!(remote.assignee.unwrap().id, "account-1");
        assert_eq!(remote.status.category, "new");
        assert_eq!(
            api.calls.lock().unwrap()[0].1,
            vec![(
                "fields".into(),
                "status,assignee,summary,description,updated,project".into()
            )]
        );
        assert!(matches!(
            remote_issue(&api, "11").await,
            Err(AppError::Scope)
        ));
    }

    #[tokio::test]
    async fn assignment_search_is_issue_scoped_and_excludes_inactive_accounts() {
        let api = Fixture::new(json!([
            {"accountId":"active","displayName":"Same name","active":true},
            {"accountId":"inactive","displayName":"Same name","active":false}
        ]));
        let users = assignees(&api, "CK-10", ("accountId", "active".into()))
            .await
            .unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].id, "active");
        let calls = api.calls.lock().unwrap();
        assert!(calls[0].1.contains(&("issueKey".into(), "CK-10".into())));
        assert!(calls[0].1.contains(&("accountId".into(), "active".into())));
    }

    #[test]
    fn unassignment_requires_editmeta_to_allow_optional_assignee() {
        assert!(can_unassign(
            &json!({"assignee":{"required":false,"operations":["set"]}})
        ));
        assert!(!can_unassign(
            &json!({"assignee":{"required":true,"operations":["set"]}})
        ));
        assert!(!can_unassign(
            &json!({"assignee":{"required":false,"operations":["add"]}})
        ));
        assert!(!can_unassign(&json!({})));
    }
}
