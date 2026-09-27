use std::{collections::HashMap, fs, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use keyring::Entry;
use reqwest::{header, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use url::Url;

mod workspace;

const SERVICE: &str = "com.personal.jiraclient";
const ACCOUNT: &str = "jira-api-token";
const PAGE_SIZE: usize = 100;

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("Use a Jira Cloud site URL like https://your-company.atlassian.net.")]
    InvalidSite,
    #[error("Enter your Jira account email and API token.")]
    MissingCredentials,
    #[error("Could not reach Jira. Check your connection and site URL, then try again.")]
    Network,
    #[error("Jira rejected the credentials. Check the account email and standard API token.")]
    Unauthorized,
    #[error("Jira does not permit this action for your account.")]
    Forbidden,
    #[error("This issue is no longer accessible in Jira.")]
    IssueUnavailable,
    #[error(
        "Jira redirected the request. This site cannot be used for direct token authentication."
    )]
    Redirect,
    #[error("Jira could not complete that request. Check project access and try again.")]
    Jira,
    #[error("The system credential vault is unavailable. No token was saved.")]
    Keyring,
    #[error("Could not save local connection settings.")]
    Config,
    #[error("No Jira connection is saved. Connect your site first.")]
    NotConnected,
    #[error("Jira returned metadata in an unexpected format.")]
    Metadata,
    #[error("The local offline cache could not be read or updated. Its last complete snapshot was not replaced.")]
    Cache,
    #[error("The offline cache was created by a newer app version. Update the app to read it.")]
    CacheVersion,
    #[error("Choose a valid workspace and page size (1–200).")]
    InvalidFilter,
    #[error("The selected project or board is not a matching Scrum workspace.")]
    Scope,
    #[error("The Jira account changed during sync. The downloaded snapshot was discarded.")]
    AccountChanged,
    #[error("Jira is rate limiting requests. The last complete offline snapshot is still available; retry later.")]
    RateLimited,
    #[error("This issue needs a fresh Jira read before it can be edited safely.")]
    UncertainBaseline,
    #[error("That edit is not available in the captured issue-specific Jira options.")]
    InvalidChange,
    #[error("This field already has an attempted or unresolved change.")]
    ChangeLocked,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

type Result<T> = std::result::Result<T, AppError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    site_url: String,
    email: String,
    account_name: String,
}

#[derive(Default, Serialize, Deserialize)]
struct LocalConfig {
    session: Option<Session>,
}

struct Connection {
    session: Session,
    token: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    #[serde(deserialize_with = "string_or_number")]
    id: String,
    key: String,
    name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Board {
    id: i64,
    name: String,
    #[serde(rename = "type")]
    board_type: String,
}

#[derive(Serialize)]
struct BoardConfig {
    columns: Vec<Column>,
}

#[derive(Serialize)]
struct Column {
    name: String,
    statuses: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FieldOption {
    id: Option<String>,
    value: Option<String>,
    keys: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateField {
    id: String,
    name: String,
    required: bool,
    schema_type: Option<String>,
    operations: Vec<String>,
    allowed_value_count: usize,
    allowed_values: Vec<FieldOption>,
    unrecognized_value_count: usize,
    unrecognized_samples: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssueTypeMetadata {
    id: String,
    name: String,
    description: Option<String>,
    fields: Vec<CreateField>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Myself {
    display_name: Option<String>,
    name: Option<String>,
    email_address: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPage {
    #[serde(default)]
    values: Vec<Project>,
    total: Option<usize>,
    is_last: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardPage {
    #[serde(default)]
    values: Vec<Board>,
    total: Option<usize>,
    is_last: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigResponse {
    column_config: RawColumnConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawColumnConfig {
    columns: Vec<RawColumn>,
}

#[derive(Deserialize)]
struct RawColumn {
    name: String,
    #[serde(default)]
    statuses: Vec<RawStatus>,
}

#[derive(Deserialize)]
struct RawStatus {
    id: String,
}

#[derive(Deserialize)]
struct StatusDetail {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueTypePage {
    #[serde(rename = "issueTypes")]
    values: Vec<RawIssueType>,
    total: Option<usize>,
    is_last: Option<bool>,
}

#[derive(Deserialize)]
struct RawIssueType {
    id: String,
    name: String,
    description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldPage {
    #[serde(rename = "fields")]
    values: Vec<Value>,
    total: Option<usize>,
    is_last: Option<bool>,
}

fn client() -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AppError::Network)
}

fn validate_site(input: &str) -> Result<String> {
    let trimmed = input.trim();
    let url = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = Url::parse(&url).map_err(|_| AppError::InvalidSite)?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.port().is_some_and(|port| port != 443)
        || !parsed.path().trim_matches('/').is_empty()
        || parsed.host_str().is_none_or(|host| {
            !host.ends_with(".atlassian.net") || host.len() <= ".atlassian.net".len()
        })
    {
        return Err(AppError::InvalidSite);
    }
    Ok(format!(
        "https://{}",
        parsed.host_str().unwrap().to_ascii_lowercase()
    ))
}

fn credential_entry() -> Result<Entry> {
    Entry::new(SERVICE, ACCOUNT).map_err(|_| AppError::Keyring)
}

fn optional_token(result: keyring::Result<String>) -> Result<Option<String>> {
    match result {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(AppError::Keyring),
    }
}

fn read_config(app: &AppHandle) -> Result<LocalConfig> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| AppError::Config)?
        .join("connection.json");
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| AppError::Config),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LocalConfig::default()),
        Err(_) => Err(AppError::Config),
    }
}

fn write_config(app: &AppHandle, config: &LocalConfig) -> Result<()> {
    let dir = app.path().app_config_dir().map_err(|_| AppError::Config)?;
    fs::create_dir_all(&dir).map_err(|_| AppError::Config)?;
    let path = dir.join("connection.json");
    let bytes = serde_json::to_vec(config).map_err(|_| AppError::Config)?;
    fs::write(path, bytes).map_err(|_| AppError::Config)
}

fn saved_connection(app: &AppHandle) -> Result<Connection> {
    let session = read_config(app)?.session.ok_or(AppError::NotConnected)?;
    let token =
        optional_token(credential_entry()?.get_password())?.ok_or(AppError::NotConnected)?;
    Ok(Connection { session, token })
}

fn auth_header(email: &str, token: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{email}:{token}")))
}

async fn jira_get(client: &Client, connection: &Connection, path: &str) -> Result<Response> {
    let url = format!("{}{}", connection.session.site_url, path);
    let response = client
        .get(url)
        .header(
            header::AUTHORIZATION,
            auth_header(&connection.session.email, &connection.token),
        )
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| AppError::Network)?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(AppError::Unauthorized),
        status if is_redirect(status) => Err(AppError::Redirect),
        status if !status.is_success() => Err(AppError::Jira),
        _ => Ok(response),
    }
}

async fn json<T: for<'de> Deserialize<'de>>(
    client: &Client,
    connection: &Connection,
    path: &str,
) -> Result<T> {
    jira_get(client, connection, path)
        .await?
        .json()
        .await
        .map_err(|_| AppError::Metadata)
}

#[tauri::command]
async fn session(app: AppHandle) -> Result<Option<Session>> {
    Ok(read_config(&app)?.session)
}

#[tauri::command]
async fn connect(
    app: AppHandle,
    site_url: String,
    email: String,
    api_token: String,
) -> Result<Session> {
    let site_url = validate_site(&site_url)?;
    let email = email.trim().to_owned();
    let token = api_token.trim().to_owned();
    if email.is_empty() || token.is_empty() || email.len() > 320 || token.len() > 4096 {
        return Err(AppError::MissingCredentials);
    }
    let connection = Connection {
        session: Session {
            site_url,
            email: email.clone(),
            account_name: String::new(),
        },
        token: token.clone(),
    };
    let client = client()?;
    let myself: Myself = json(&client, &connection, "/rest/api/3/myself").await?;
    let account_name = myself
        .display_name
        .or(myself.name)
        .or(myself.email_address)
        .unwrap_or_else(|| email.clone());
    let session = Session {
        account_name,
        ..connection.session
    };
    let _identity = workspace::identity_gate().lock().await;
    credential_entry()?
        .set_password(&token)
        .map_err(|_| AppError::Keyring)?;
    workspace::bump_identity_generation();
    if let Err(error) = write_config(
        &app,
        &LocalConfig {
            session: Some(session.clone()),
        },
    ) {
        let _ = credential_entry()?.delete_credential();
        return Err(error);
    }
    Ok(session)
}

#[tauri::command]
async fn disconnect(app: AppHandle) -> Result<()> {
    let _identity = workspace::identity_gate().lock().await;
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => (),
        Err(_) => return Err(AppError::Keyring),
    }
    workspace::bump_identity_generation();
    let config = LocalConfig { session: None };
    write_config(&app, &config)
}

#[tauri::command]
async fn projects(app: AppHandle) -> Result<Vec<Project>> {
    let connection = saved_connection(&app)?;
    let client = client()?;
    let mut start = 0;
    let mut all = Vec::new();
    loop {
        let page: ProjectPage = json(
            &client,
            &connection,
            &format!("/rest/api/3/project/search?startAt={start}&maxResults={PAGE_SIZE}"),
        )
        .await?;
        let next = should_fetch_next(page.total, page.is_last, start, page.values.len())?;
        start += page.values.len();
        all.extend(page.values);
        if !next {
            break;
        }
    }
    Ok(all)
}

#[tauri::command]
async fn boards(app: AppHandle, project_key: String) -> Result<Vec<Board>> {
    validate_project_key(&project_key)?;
    let connection = saved_connection(&app)?;
    let client = client()?;
    let mut start = 0;
    let mut all = Vec::new();
    loop {
        let page: BoardPage = json(&client, &connection, &format!("/rest/agile/1.0/board?projectKeyOrId={project_key}&startAt={start}&maxResults={PAGE_SIZE}")).await?;
        let next = should_fetch_next(page.total, page.is_last, start, page.values.len())?;
        start += page.values.len();
        all.extend(page.values);
        if !next {
            break;
        }
    }
    Ok(all)
}

#[tauri::command]
async fn board_config(app: AppHandle, board_id: i64) -> Result<BoardConfig> {
    if board_id <= 0 {
        return Err(AppError::Metadata);
    }
    let connection = saved_connection(&app)?;
    let client = client()?;
    let config: ConfigResponse = json(
        &client,
        &connection,
        &format!("/rest/agile/1.0/board/{board_id}/configuration"),
    )
    .await?;
    let statuses: Vec<StatusDetail> = json(&client, &connection, "/rest/api/3/status").await?;
    Ok(normalize_board_config(config, statuses))
}

fn normalize_board_config(config: ConfigResponse, statuses: Vec<StatusDetail>) -> BoardConfig {
    let names: HashMap<_, _> = statuses
        .into_iter()
        .map(|status| (status.id, status.name))
        .collect();
    BoardConfig {
        columns: config
            .column_config
            .columns
            .into_iter()
            .map(|column| Column {
                name: column.name,
                statuses: column
                    .statuses
                    .into_iter()
                    .map(|status| {
                        names
                            .get(&status.id)
                            .cloned()
                            .unwrap_or_else(|| format!("Status {}", status.id))
                    })
                    .collect(),
            })
            .collect(),
    }
}

#[tauri::command]
async fn create_metadata(app: AppHandle, project_key: String) -> Result<Vec<IssueTypeMetadata>> {
    validate_project_key(&project_key)?;
    let connection = saved_connection(&app)?;
    let client = client()?;
    let mut start = 0;
    let mut issue_types = Vec::new();
    loop {
        let page: IssueTypePage = json(&client, &connection, &format!("/rest/api/3/issue/createmeta/{project_key}/issuetypes?startAt={start}&maxResults={PAGE_SIZE}")).await?;
        let next = should_fetch_next(page.total, page.is_last, start, page.values.len())?;
        start += page.values.len();
        issue_types.extend(page.values);
        if !next {
            break;
        }
    }
    let mut all = Vec::with_capacity(issue_types.len());
    for issue_type in issue_types {
        let mut start = 0;
        let mut fields = Vec::new();
        loop {
            let page: FieldPage = json(&client, &connection, &format!("/rest/api/3/issue/createmeta/{project_key}/issuetypes/{}?startAt={start}&maxResults={PAGE_SIZE}", issue_type.id)).await?;
            let next = should_fetch_next(page.total, page.is_last, start, page.values.len())?;
            start += page.values.len();
            fields.extend(
                page.values
                    .into_iter()
                    .map(normalize_field)
                    .collect::<Result<Vec<_>>>()?,
            );
            if !next {
                break;
            }
        }
        all.push(IssueTypeMetadata {
            id: issue_type.id,
            name: issue_type.name,
            description: issue_type.description,
            fields,
        });
    }
    Ok(all)
}

fn normalize_field(value: Value) -> Result<CreateField> {
    let id = value
        .get("fieldId")
        .or_else(|| value.get("key"))
        .and_then(string_or_numeric_value)
        .ok_or(AppError::Metadata)?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_owned();
    let required = value
        .get("required")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let schema_type = value
        .pointer("/schema/type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let operations = value
        .get("operations")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let options = value
        .get("allowedValues")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let unrecognized = options
        .iter()
        .filter(|option| option_label(option).is_none())
        .collect::<Vec<_>>();
    let unrecognized_samples = unrecognized
        .iter()
        .take(3)
        .map(|option| option_keys(option).join(", "))
        .collect();
    let allowed_values = options
        .iter()
        .take(10)
        .map(|option| FieldOption {
            id: option.get("id").and_then(string_or_numeric_value),
            value: option_label(option),
            keys: option_keys(option),
        })
        .collect();
    Ok(CreateField {
        id,
        name,
        required,
        schema_type,
        operations,
        allowed_value_count: options.len(),
        allowed_values,
        unrecognized_value_count: unrecognized.len(),
        unrecognized_samples,
    })
}

fn option_label(option: &Value) -> Option<String> {
    option
        .get("value")
        .or_else(|| option.get("name"))
        .or_else(|| option.get("displayName"))
        .and_then(string_or_numeric_value)
}

fn option_keys(option: &Value) -> Vec<String> {
    match option {
        Value::Object(map) => map.keys().cloned().collect(),
        Value::Null => vec!["null".into()],
        Value::String(_) => vec!["string".into()],
        Value::Number(_) => vec!["number".into()],
        Value::Bool(_) => vec!["boolean".into()],
        Value::Array(_) => vec!["array".into()],
    }
}

fn string_or_numeric_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn should_fetch_next(
    total: Option<usize>,
    is_last: Option<bool>,
    start: usize,
    returned: usize,
) -> Result<bool> {
    if is_last == Some(true) {
        return Ok(false);
    }
    if returned == 0 {
        return if is_last == Some(false) || total.is_some_and(|total| start < total) {
            Err(AppError::Metadata)
        } else {
            Ok(false)
        };
    }
    Ok(is_last == Some(false) || total.is_none_or(|total| start.saturating_add(returned) < total))
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn string_or_number<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<String, D::Error> {
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(value) => Ok(value),
        Value::Number(value) => Ok(value.to_string()),
        _ => Err(serde::de::Error::custom(
            "expected string or numeric identifier",
        )),
    }
}

fn validate_project_key(key: &str) -> Result<()> {
    if key.is_empty()
        || key.len() > 64
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(AppError::Metadata);
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            workspace::start_worker(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session,
            connect,
            disconnect,
            projects,
            boards,
            board_config,
            create_metadata,
            workspace::cache_workspaces,
            workspace::cache_workspace,
            workspace::cache_issues,
            workspace::cache_issue,
            workspace::sync_workspace,
            workspace::list_changes,
            workspace::issue_capabilities,
            workspace::enqueue_change,
            workspace::resolve_change,
            workspace::sync_changes
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Jira Client");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bare_https_atlassian_cloud_hosts() {
        assert_eq!(
            validate_site(" cargoking.atlassian.net ").unwrap(),
            "https://cargoking.atlassian.net"
        );
        assert_eq!(
            validate_site("Example.atlassian.net/").unwrap(),
            "https://example.atlassian.net"
        );
        assert_eq!(
            validate_site(" https://Example.atlassian.net/ ").unwrap(),
            "https://example.atlassian.net"
        );
        for bad in [
            "http://example.atlassian.net",
            "https://atlassian.net",
            "https://example.atlassian.net.evil.test",
            "https://user@example.atlassian.net",
            "https://example.atlassian.net/path",
            "https://example.atlassian.net?x=1",
            "https://example.atlassian.net:8443",
            "example.atlassian.net.evil.test",
            "user@example.atlassian.net",
            "example.atlassian.net/path",
        ] {
            assert!(validate_site(bad).is_err(), "unexpectedly accepted {bad}");
        }
    }

    #[test]
    fn pagination_continues_without_total_and_rejects_explicit_no_progress() {
        let first: BoardPage = serde_json::from_value(serde_json::json!({
            "values":[{"id":1,"name":"Main","type":"scrum"}],"isLast":false
        }))
        .unwrap();
        assert_eq!(first.total, None);
        assert!(should_fetch_next(first.total, first.is_last, 0, first.values.len()).unwrap());
        assert!(!should_fetch_next(None, Some(true), 1, 1).unwrap());
        assert!(matches!(
            should_fetch_next(None, Some(false), 1, 0),
            Err(AppError::Metadata)
        ));
        assert!(should_fetch_next(Some(250), None, 100, 100).unwrap());
        assert!(!should_fetch_next(Some(250), None, 200, 50).unwrap());
    }

    #[test]
    fn create_field_pages_preserve_total_numeric_ids_and_unknown_shapes() {
        let mut options = (0..152)
            .map(|i| serde_json::json!({"id":i,"value":format!("Version {i}")}))
            .collect::<Vec<_>>();
        options.insert(1, serde_json::json!({"id":999,"providerCode":"custom"}));
        let page: FieldPage = serde_json::from_value(serde_json::json!({
            "maxResults":100,"startAt":0,"total":1,"isLast":true,
            "fields":[{"fieldId":"fixVersions","name":"Fix versions","required":false,
                "schema":{"type":"array"},"operations":["set"],"allowedValues":options}]
        }))
        .unwrap();
        let field = normalize_field(page.values.into_iter().next().unwrap()).unwrap();
        assert_eq!(field.id, "fixVersions");
        assert_eq!(field.schema_type.as_deref(), Some("array"));
        assert_eq!(field.allowed_value_count, 153);
        assert_eq!(field.allowed_values.len(), 10);
        assert_eq!(field.allowed_values[0].id.as_deref(), Some("0"));
        assert_eq!(field.allowed_values[0].value.as_deref(), Some("Version 0"));
        assert_eq!(field.allowed_values[1].value, None);
        assert_eq!(field.unrecognized_value_count, 1);
        assert_eq!(field.unrecognized_samples, ["id, providerCode"]);
    }

    #[test]
    fn issue_type_listing_and_board_configuration_follow_cloud_response_shapes() {
        let types: IssueTypePage = serde_json::from_value(serde_json::json!({
            "maxResults":50,"startAt":0,"total":1,"issueTypes":[{"id":"10001","name":"Task"}]
        }))
        .unwrap();
        assert_eq!(types.values[0].name, "Task");
        assert!(!should_fetch_next(types.total, types.is_last, 0, types.values.len()).unwrap());
        let config: ConfigResponse = serde_json::from_value(serde_json::json!({
            "columnConfig":{"columns":[{"name":"In progress","statuses":[{"id":"3"},{"id":"77"}]}]}
        }))
        .unwrap();
        let board = normalize_board_config(
            config,
            vec![StatusDetail {
                id: "3".into(),
                name: "In Progress".into(),
            }],
        );
        assert_eq!(board.columns[0].statuses, ["In Progress", "Status 77"]);
    }

    #[test]
    fn create_metadata_rejects_missing_collections_instead_of_defaulting_to_empty() {
        let malformed = serde_json::json!({"total":0,"values":[]});
        assert!(serde_json::from_value::<IssueTypePage>(malformed.clone()).is_err());
        assert!(serde_json::from_value::<FieldPage>(malformed).is_err());

        let types: IssueTypePage = serde_json::from_value(serde_json::json!({
            "total":0,"issueTypes":[]
        }))
        .unwrap();
        let fields: FieldPage = serde_json::from_value(serde_json::json!({
            "total":0,"fields":[]
        }))
        .unwrap();
        assert!(!should_fetch_next(types.total, types.is_last, 0, types.values.len()).unwrap());
        assert!(!should_fetch_next(fields.total, fields.is_last, 0, fields.values.len()).unwrap());
    }

    #[test]
    fn missing_credential_is_distinct_from_inaccessible_vault() {
        assert_eq!(optional_token(Err(keyring::Error::NoEntry)).unwrap(), None);
        assert!(matches!(
            optional_token(Err(keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::other("locked")
            )))),
            Err(AppError::Keyring)
        ));
    }

    #[test]
    fn authorization_header_contains_only_expected_basic_credentials() {
        let value = auth_header("user@example.com", "sample-token");
        assert!(value.starts_with("Basic "));
        assert!(!value.contains("sample-token"));
    }

    #[test]
    fn all_redirect_statuses_are_rejected() {
        for status in [
            StatusCode::MOVED_PERMANENTLY,
            StatusCode::FOUND,
            StatusCode::SEE_OTHER,
            StatusCode::TEMPORARY_REDIRECT,
            StatusCode::PERMANENT_REDIRECT,
        ] {
            assert!(is_redirect(status));
        }
        assert!(!is_redirect(StatusCode::OK));
        assert!(!AppError::Redirect.to_string().contains("sample-token"));
    }

    #[test]
    fn project_identifiers_accept_jira_numeric_ids() {
        let project: Project =
            serde_json::from_value(serde_json::json!({"id":10042,"key":"CK","name":"CargoKing"}))
                .unwrap();
        assert_eq!(project.id, "10042");
    }
}
