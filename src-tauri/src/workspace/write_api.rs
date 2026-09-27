use serde_json::{json, Value};

use super::{
    jira::{Api, HttpApi, WriteFailure},
    model::{
        Assignee, CapabilityTransition, IssueCapabilities, IssueStatus, RemoteFields, StoredChange,
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
    let raw = api
        .get(
            &format!("/rest/api/3/issue/{issue_id}"),
            &[("fields", "status,assignee,updated,project".into())],
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
    Ok(RemoteFields {
        issue_id: id.into(),
        key: text(&raw, "/key")?.into(),
        project_key: text(&raw, "/fields/project/key")?.into(),
        status: parse_status(raw.pointer("/fields/status").ok_or(AppError::Metadata)?)?,
        assignee,
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
    let assignees = if can_assign {
        assignees(api, &remote.key, ("query", query.into())).await?
    } else {
        vec![]
    };
    let now = chrono::Utc::now().to_rfc3339();
    Ok(IssueCapabilities {
        source_status_id: remote.status.id.clone(),
        transitions_captured_at: Some(now.clone()),
        assignees_captured_at: Some(now),
        transitions,
        assignees,
        can_assign,
        assignee_query: query.into(),
        assignees_complete: false,
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
            let target = record
                .change
                .requested
                .id
                .clone()
                .ok_or(AppError::InvalidChange)?;
            if !can_assign(api, &remote.issue_id).await? {
                return Err(AppError::Forbidden);
            }
            let candidates = assignees(api, &remote.key, ("accountId", target.clone())).await?;
            if candidates.iter().any(|user| user.id == target) {
                Ok(())
            } else {
                Err(AppError::InvalidChange)
            }
        }
        _ => Err(AppError::InvalidChange),
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
            "project":{"key":"CK"},"updated":"2026-09-27T10:00:00Z",
            "status":{"id":"1","name":"Ready","statusCategory":{"key":"new"}},
            "assignee":{"accountId":"account-1","displayName":"Yi"}
        }}));
        let remote = remote_issue(&api, "10").await.unwrap();
        assert_eq!(remote.assignee.unwrap().id, "account-1");
        assert_eq!(remote.status.category, "new");
        assert_eq!(
            api.calls.lock().unwrap()[0].1,
            vec![("fields".into(), "status,assignee,updated,project".into())]
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
}
