package coolify

import (
	"fmt"
	"regexp"
	"strings"
)

// The reading table: which Coolify table and columns each `kind:uuid` ref may reach, under which consent class and in which stored form.
// SQL is built ONLY from this Go table and from refs that matched refRe; no request ever names a table, a column or a SQL fragment.
//
// Everything here is metadata about WHERE a secret lives in Coolify's schema (v4.3 to v4.7.x). The column and table names are checked
// against a real Coolify in the lab (LAB-DOĞRULA); a column a version lacks is reported as `column_missing`, never guessed.
//
// T0 (never readable): the app key, Coolify's own database and Redis passwords, and every server SSH private key. The last one lives in
// the same table as deploy keys, so `private_key` refs carry a guard that only matches rows Coolify marks as git related.

// Class names (mirror COOLIFY_SECRET_CLASSES in @tugra/shared).
const (
	ClassEnv         = "env"
	ClassSharedEnv   = "shared_env"
	ClassDBCreds     = "db_credentials"
	ClassBasicAuth   = "basic_auth"
	ClassServiceYAML = "service_compose"
	ClassTaskCommand = "task_command"
	ClassS3          = "s3"
	ClassNotify      = "notification"
	ClassGitAppKey   = "git_app_key"
	ClassDeployKey   = "deploy_key"
)

// Classes is the full list, in the shared order.
var Classes = []string{ClassEnv, ClassSharedEnv, ClassDBCreds, ClassBasicAuth, ClassServiceYAML, ClassTaskCommand, ClassS3, ClassNotify, ClassGitAppKey, ClassDeployKey}

// Kinds is the list of ref kinds, in the shared order.
var Kinds = []string{"env", "shared_env", "database", "service", "application", "scheduled_task", "s3", "notification", "git_app", "private_key", "file_volume"}

// Field forms: how the helper treats the stored text.
const (
	FormSerialized = "serialized" // encrypt() of a PHP string
	FormString     = "string"     // encryptString()
	FormAuto       = "auto"       // not known: unwrap the exact serialized shape, otherwise take it as it is
	FormPlain      = "plain"      // stored readable: only sealed, never decrypted
)

// Field is one column.
type Field struct {
	Col     string
	Class   string
	Form    string
	PlainOK bool // may hold an unencrypted value written before Coolify 4.5.0
	// Optional: the column exists only in some Coolify versions or for some resources (config text, labels). A version without it is a
	// normal answer, not an error: no record is produced and the hub keeps "absent".
	Optional bool
}

// Table is one source table of a kind.
type Table struct {
	Name   string
	Key    string // SQL expression of the ref's id; a fixed literal from this file
	Guard  string // extra WHERE condition (fixed literal) or ""
	Fields []Field
}

var kindTables = map[string][]Table{
	"env": {{Name: "environment_variables", Key: "uuid", Fields: []Field{{Col: "value", Class: ClassEnv, Form: FormSerialized}}}},
	// shared_environment_variables carrying a uuid column is assumed (LAB-DOĞRULA); without it the kind answers column_missing.
	"shared_env": {{Name: "shared_environment_variables", Key: "uuid", Fields: []Field{{Col: "value", Class: ClassSharedEnv, Form: FormString}}}},
	"database": {
		{Name: "standalone_postgresqls", Key: "uuid", Fields: []Field{{Col: "postgres_password", Class: ClassDBCreds, Form: FormString}, {Col: "postgres_conf", Class: ClassDBCreds, Form: FormPlain, Optional: true}}},
		{Name: "standalone_mysqls", Key: "uuid", Fields: []Field{{Col: "mysql_password", Class: ClassDBCreds, Form: FormString}, {Col: "mysql_root_password", Class: ClassDBCreds, Form: FormString}, {Col: "mysql_conf", Class: ClassDBCreds, Form: FormPlain, Optional: true}}},
		{Name: "standalone_mariadbs", Key: "uuid", Fields: []Field{{Col: "mariadb_password", Class: ClassDBCreds, Form: FormString}, {Col: "mariadb_root_password", Class: ClassDBCreds, Form: FormString, PlainOK: true}, {Col: "mariadb_conf", Class: ClassDBCreds, Form: FormPlain, Optional: true}}},
		{Name: "standalone_mongodbs", Key: "uuid", Fields: []Field{{Col: "mongo_initdb_root_password", Class: ClassDBCreds, Form: FormAuto, PlainOK: true}, {Col: "mongo_conf", Class: ClassDBCreds, Form: FormPlain, Optional: true}}},
		{Name: "standalone_keydbs", Key: "uuid", Fields: []Field{{Col: "keydb_password", Class: ClassDBCreds, Form: FormString}, {Col: "keydb_conf", Class: ClassDBCreds, Form: FormPlain, Optional: true}}},
		{Name: "standalone_dragonflies", Key: "uuid", Fields: []Field{{Col: "dragonfly_password", Class: ClassDBCreds, Form: FormString}, {Col: "dragonfly_conf", Class: ClassDBCreds, Form: FormPlain, Optional: true}}},
		// A Redis database keeps its password in environment_variables (REDIS_PASSWORD); the table holds only its config text.
		{Name: "standalone_redis", Key: "uuid", Fields: []Field{{Col: "redis_conf", Class: ClassDBCreds, Form: FormPlain, Optional: true}}},
		{Name: "standalone_clickhouses", Key: "uuid", Fields: []Field{{Col: "clickhouse_admin_password", Class: ClassDBCreds, Form: FormString}}},
	},
	"service": {{Name: "services", Key: "uuid", Fields: []Field{{Col: "docker_compose_raw", Class: ClassServiceYAML, Form: FormPlain}}}},
	// A config file of a service (and of an application) lives in local_file_volumes; its content is encrypted by Coolify (older rows may
	// be readable). The ref id is the row id.
	"file_volume": {{Name: "local_file_volumes", Key: "id::text", Fields: []Field{{Col: "content", Class: ClassServiceYAML, Form: FormString, PlainOK: true}}}},
	"application": {{Name: "applications", Key: "uuid", Fields: []Field{
		// Build and compose text of an application (stored readable; sealed here because it can hold a secret). The hub carries these with
		// the compose file of a service: one consent class, "service_compose".
		{Col: "docker_compose_raw", Class: ClassServiceYAML, Form: FormPlain, Optional: true},
		{Col: "dockerfile", Class: ClassServiceYAML, Form: FormPlain, Optional: true},
		{Col: "custom_labels", Class: ClassServiceYAML, Form: FormPlain, Optional: true},
		{Col: "http_basic_auth_password", Class: ClassBasicAuth, Form: FormString},
		{Col: "manual_webhook_secret_github", Class: ClassBasicAuth, Form: FormString},
		{Col: "manual_webhook_secret_gitlab", Class: ClassBasicAuth, Form: FormString},
		{Col: "manual_webhook_secret_bitbucket", Class: ClassBasicAuth, Form: FormString},
		{Col: "manual_webhook_secret_gitea", Class: ClassBasicAuth, Form: FormString},
		{Col: "git_https_password", Class: ClassGitAppKey, Form: FormString},
	}}},
	"scheduled_task": {{Name: "scheduled_tasks", Key: "uuid", Fields: []Field{{Col: "command", Class: ClassTaskCommand, Form: FormPlain}}}},
	"s3":             {{Name: "s3_storages", Key: "uuid", Fields: []Field{{Col: "key", Class: ClassS3, Form: FormString}, {Col: "secret", Class: ClassS3, Form: FormString}}}},
	// Notification settings are one row per Coolify team and are keyed by the team id (LAB-DOĞRULA for 4.7.x).
	"notification": {
		{Name: "email_notification_settings", Key: "team_id::text", Fields: []Field{{Col: "smtp_password", Class: ClassNotify, Form: FormString}, {Col: "resend_api_key", Class: ClassNotify, Form: FormString}}},
		{Name: "discord_notification_settings", Key: "team_id::text", Fields: []Field{{Col: "discord_webhook_url", Class: ClassNotify, Form: FormString}}},
		{Name: "slack_notification_settings", Key: "team_id::text", Fields: []Field{{Col: "slack_webhook_url", Class: ClassNotify, Form: FormString}}},
		{Name: "telegram_notification_settings", Key: "team_id::text", Fields: []Field{{Col: "telegram_token", Class: ClassNotify, Form: FormString}}},
		{Name: "pushover_notification_settings", Key: "team_id::text", Fields: []Field{{Col: "pushover_user_key", Class: ClassNotify, Form: FormString}, {Col: "pushover_api_token", Class: ClassNotify, Form: FormString}}},
		{Name: "webhook_notification_settings", Key: "team_id::text", Fields: []Field{{Col: "webhook_url", Class: ClassNotify, Form: FormString}}},
	},
	"git_app": {
		{Name: "github_apps", Key: "uuid", Fields: []Field{{Col: "client_secret", Class: ClassGitAppKey, Form: FormString, PlainOK: true}, {Col: "webhook_secret", Class: ClassGitAppKey, Form: FormString, PlainOK: true}}},
		{Name: "gitlab_apps", Key: "uuid", Fields: []Field{{Col: "access_token", Class: ClassGitAppKey, Form: FormString}, {Col: "refresh_token", Class: ClassGitAppKey, Form: FormString}, {Col: "client_secret", Class: ClassGitAppKey, Form: FormString}, {Col: "app_secret", Class: ClassGitAppKey, Form: FormString, PlainOK: true}}},
		{Name: "gitea_apps", Key: "uuid", Fields: []Field{{Col: "client_secret", Class: ClassGitAppKey, Form: FormString}, {Col: "webhook_secret", Class: ClassGitAppKey, Form: FormString}}},
	},
	// T0 guard: private_keys also holds every server's SSH key. Only a row Coolify itself marks as git related is reachable; on a version
	// without that column the statement fails and the ref answers column_missing (fail closed).
	"private_key": {{Name: "private_keys", Key: "uuid", Guard: "t.is_git_related is true", Fields: []Field{{Col: "private_key", Class: ClassDeployKey, Form: FormString}}}},
}

var (
	// refRe is the whole ref: a known kind, a colon and an id of letters, digits, '-' and '_' (Coolify uuids are short cuid-like strings,
	// notification refs are numeric team ids). No quote, no space, no SQL metacharacter can match.
	refRe   = regexp.MustCompile(`^([a-z0-9_]{1,20}):([A-Za-z0-9_-]{1,64})$`)
	identRe = regexp.MustCompile(`^[a-z_][a-z0-9_]*(::text)?$`)
	idRe    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// SplitRef validates `kind:id` against the table. It returns false for an unknown kind or any character outside the id charset.
func SplitRef(ref string) (kind, id string, ok bool) {
	m := refRe.FindStringSubmatch(ref)
	if m == nil {
		return "", "", false
	}
	if _, known := kindTables[m[1]]; !known {
		return "", "", false
	}
	return m[1], m[2], true
}

// knownClass reports whether c is one of the consent classes.
func knownClass(c string) bool {
	for _, k := range Classes {
		if k == c {
			return true
		}
	}
	return false
}

// kindHasClass reports whether a kind has at least one field in one of the consented classes.
func kindHasClass(kind string, consent map[string]bool) bool {
	for _, t := range kindTables[kind] {
		for _, f := range t.Fields {
			if consent[f.Class] {
				return true
			}
		}
	}
	return false
}

// BuildQuery returns the one SELECT for one table: a JSON object per row with, per consented column, whether the column exists and its
// stored text. Only consented columns are named, so a class the owner did not tick is never even selected. ids must already have
// passed SplitRef.
func BuildQuery(t Table, ids []string, consent map[string]bool) (string, []Field, error) {
	if !identRe.MatchString(t.Key) || !identRe.MatchString(t.Name) {
		return "", nil, fmt.Errorf("bad table spec")
	}
	var fields []Field
	var cols []string
	for _, f := range t.Fields {
		if !consent[f.Class] {
			continue
		}
		if !identRe.MatchString(f.Col) {
			return "", nil, fmt.Errorf("bad column spec")
		}
		fields = append(fields, f)
		cols = append(cols, fmt.Sprintf("'%s', json_build_object('p', to_jsonb(t) ? '%s', 'v', to_jsonb(t)->>'%s')", f.Col, f.Col, f.Col))
	}
	if len(fields) == 0 || len(ids) == 0 {
		return "", nil, nil
	}
	lits := make([]string, len(ids))
	for i, id := range ids {
		if !idRe.MatchString(id) {
			return "", nil, fmt.Errorf("bad id")
		}
		lits[i] = "'" + id + "'"
	}
	key := strings.TrimSuffix(t.Key, "::text")
	where := fmt.Sprintf("t.%s::text in (%s)", key, strings.Join(lits, ","))
	if t.Guard != "" {
		where += " and " + t.Guard
	}
	sql := fmt.Sprintf("select json_build_object('ref', t.%s::text, 'f', json_build_object(%s))::text from %s t where %s;\n", key, strings.Join(cols, ", "), t.Name, where)
	return sql, fields, nil
}
