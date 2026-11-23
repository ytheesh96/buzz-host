#!/bin/sh
# Block Antigravity's built-in `schedule` tool for Buzz-hosted agents so
# delayed checks and recurring work go through Buzz Attention (visible to the
# owner in Buzz). Owner interactive `agy` sessions outside Buzz do not set
# BUZZ_HOST_AGENT, BUZZ_MANAGED_AGENT, or BUZZ_HOST_SANDBOX and stay allowed.
cat >/dev/null
if [ -n "${BUZZ_HOST_AGENT:-}${BUZZ_MANAGED_AGENT:-}${BUZZ_HOST_SANDBOX:-}" ]; then
  printf '%s\n' '{"decision":"deny","reason":"Runtime scheduling (schedule) is disabled for Buzz agents because it wakes invisibly outside Buzz. Use Buzz Attention (interest_set + watch_add) instead so your owner has visibility in Buzz, or tell your owner if Attention is off."}'
else
  printf '%s\n' '{"decision":"allow"}'
fi
