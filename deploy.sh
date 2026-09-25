#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
ENV_FILE=${ENV_FILE:-"$ROOT_DIR/.env.local"}
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

usage() {
  cat <<'EOF'
Usage: ./deploy.sh <command>

Commands:
  install    Create .env.local when missing, validate it, and deploy
  up         Rebuild and start the application and scheduler
  build      Rebuild application images
  status     Show service status
  logs       Follow service logs
  restart    Restart services without rebuilding
  down       Stop and remove services and networks
  help       Show this help
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_compose() {
  command -v docker >/dev/null 2>&1 || die 'Docker is not installed or not in PATH.'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is not available.'
  docker info >/dev/null 2>&1 || die 'The Docker daemon is not reachable.'
}

require_env_file() {
  [ -f "$ENV_FILE" ] || die "Missing $ENV_FILE. Run './deploy.sh install' first."
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

value_for() {
  grep -m 1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d '=' -f 2-
}

require_value() {
  value_for "$1" >/dev/null
  value=$(value_for "$1")
  [ -n "$value" ] || die "$1 is missing in $ENV_FILE."
  case "$value" in
    *your_*)
      die "$1 still contains an example value in $ENV_FILE."
      ;;
  esac
}

validate_env() {
  require_env_file

  for key in \
    NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_APP_URL \
    CRON_SECRET
  do
    require_value "$key"
  done

  case "$(value_for NEXT_PUBLIC_APP_URL)" in
    http://*|https://*) ;;
    *) die 'NEXT_PUBLIC_APP_URL must start with http:// or https://.' ;;
  esac

  if [ -z "$(value_for FIREBASE_SERVICE_ACCOUNT_KEY)" ]; then
    require_value FIREBASE_ADMIN_PROJECT_ID
    require_value FIREBASE_ADMIN_CLIENT_EMAIL
    require_value FIREBASE_ADMIN_PRIVATE_KEY
  fi
}

create_env() {
  if [ -f "$ENV_FILE" ]; then
    return
  fi

  [ ! -e "$ENV_FILE" ] || die "$ENV_FILE exists but is not a regular file."
  cp "$ROOT_DIR/.env.local.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf 'Created %s. Set the Firebase, URL and secret values, then run this command again.\n' "$ENV_FILE"
  exit 1
}

deploy() {
  validate_env
  compose up -d --build --remove-orphans
  printf 'Deployment ready at %s\n' "$(value_for NEXT_PUBLIC_APP_URL)"
}

command=${1:-help}

case "$command" in
  install)
    require_compose
    create_env
    deploy
    ;;
  up)
    require_compose
    deploy
    ;;
  build)
    require_compose
    validate_env
    compose build --pull
    ;;
  status)
    require_compose
    require_env_file
    compose ps
    ;;
  logs)
    require_compose
    require_env_file
    compose logs --follow "$@"
    ;;
  restart)
    require_compose
    require_env_file
    compose restart
    ;;
  down)
    require_compose
    require_env_file
    compose down
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
