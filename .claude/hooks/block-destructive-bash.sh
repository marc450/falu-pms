#!/usr/bin/env bash
# PreToolUse hook for Bash. Blocks commands that:
#   1) target the production Supabase project (paatfvothtonztazffyx)
#   2) contain destructive SQL DDL (DROP / TRUNCATE on tables, schemas, etc.)
#
# Prefix-matchable destructive commands (rm -rf, git push --force, etc.)
# are blocked via the permissions.deny array in settings.json. This hook
# handles patterns that can appear anywhere in a command string, which the
# prefix matcher cannot catch.
#
# The hook reads PreToolUse JSON on stdin and emits a permissionDecision
# of "deny" with a reason when a pattern matches. Exit code is always 0;
# the deny is communicated via the JSON payload.

set -u

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

emit_deny() {
  jq -nc --arg msg "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $msg
    }
  }'
  exit 0
}

# 1) Prod Supabase project — never touch directly from an agent
if printf '%s' "$cmd" | grep -qiE 'paatfvothtonztazffyx'; then
  emit_deny "Blocked: command references the production Supabase project (paatfvothtonztazffyx). Agents must never touch prod directly. Use the staging project, or have a human apply changes via the migration pipeline."
fi

# 2) Destructive SQL DDL — only when the command also runs a SQL tool.
#    This avoids false positives on commands that merely mention "drop" as a
#    word (e.g. `grep -n drop database/migrations/*.sql`).
if printf '%s' "$cmd" | grep -qiE '(\bpsql\b|\bdropdb\b|\bsupabase[[:space:]]+db\b|\bpgcli\b)'; then
  if printf '%s' "$cmd" | grep -qiE '(^|[^a-z_])(drop|truncate)[[:space:]]+(table|schema|database|materialized[[:space:]]+view|view|index|function|trigger|policy|role|user|publication|extension|sequence|type)\b'; then
    emit_deny "Blocked: destructive SQL (DROP/TRUNCATE) detected in command. Schema changes must go through database/migrations/*.sql, applied by the deploy pipeline, not ad-hoc SQL."
  fi
fi

exit 0
