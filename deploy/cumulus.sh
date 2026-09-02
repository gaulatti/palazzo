#!/usr/bin/env bash

set -euo pipefail

ghcr_user="$1"
ghcr_token_base64="$2"
broadcast_secret_id="$3"
icecast_secret_id="$4"
image="$5"
nginx_config_base64="$6"
program_id="$7"
docker_config_dir='/tmp/palazzo-docker-config'

test -n "$broadcast_secret_id"
test -n "$icecast_secret_id"
test -n "$program_id"

broadcast_payload="$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$broadcast_secret_id" \
  --query SecretString \
  --output text)"
control_token="$(BROADCAST_PAYLOAD="$broadcast_payload" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ['BROADCAST_PAYLOAD'])
token = payload.get('palazzoControlToken')
if not isinstance(token, str) or not 16 <= len(token) <= 4096:
    raise SystemExit('Palazzo control token is invalid')
print(token)
PY
)"
icecast_source_password="$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$icecast_secret_id" \
  --query SecretString \
  --output text)"
test -n "$icecast_source_password"

install -d -m 0700 /etc/palazzo
umask 077
printf '%s' "$control_token" > /etc/palazzo/control-token
unset broadcast_payload control_token

rm -rf "$docker_config_dir"
install -d -m 0700 "$docker_config_dir"
printf '%s' "$ghcr_token_base64" | base64 -d | docker --config "$docker_config_dir" login ghcr.io --username "$ghcr_user" --password-stdin
docker --config "$docker_config_dir" pull "$image"
rm -rf "$docker_config_dir"

docker network inspect broadcast-control >/dev/null 2>&1 || docker network create broadcast-control
docker volume create palazzo-fillers >/dev/null
if docker inspect palazzo-candidate >/dev/null 2>&1 || docker inspect palazzo-rollback >/dev/null 2>&1; then
  echo 'A previous Palazzo deployment candidate or rollback container requires operator review'
  exit 1
fi

cleanup_candidate() {
  docker rm -f palazzo-candidate >/dev/null 2>&1 || true
}
trap cleanup_candidate EXIT

docker run -d --name palazzo-candidate \
  --network broadcast-control \
  --volume /etc/palazzo/control-token:/run/secrets/palazzo-control-token:ro \
  -e PALAZZO_PORT=3100 \
  -e PALAZZO_INSTANCE_ID=palazzo-production-candidate \
  -e PROGRAM_ID="$program_id" \
  -e PALAZZO_CONTROL_TOKEN_FILE=/run/secrets/palazzo-control-token \
  -e ICECAST_PORT=8000 \
  -e ICECAST_SOURCE_PASSWORD="$icecast_source_password" \
  "$image"

candidate_ready=false
for _ in $(seq 1 45); do
  if docker exec palazzo-candidate node -e 'fetch("http://127.0.0.1:3100/playback/state").then(async response=>{const state=await response.json();if(!response.ok||state.liquidsoap?.running!==true||state.liquidsoap?.connected!==true||state.icecast?.connected!==true)throw new Error("transport not ready")}).catch(error=>{console.error(error.message);process.exit(1)})'; then
    candidate_ready=true
    break
  fi
  sleep 2
done
if [ "$candidate_ready" != true ]; then
  echo 'Palazzo candidate failed its transport and lifecycle checks'
  docker logs --tail 200 palazzo-candidate || true
  exit 1
fi

cleanup_candidate
trap - EXIT

rollback_available=false
if docker inspect palazzo >/dev/null 2>&1; then
  docker stop palazzo
  docker rename palazzo palazzo-rollback
  rollback_available=true
fi

if ! docker run -d --name palazzo \
  --network broadcast-control \
  --volume /etc/palazzo/control-token:/run/secrets/palazzo-control-token:ro \
  --volume palazzo-fillers:/var/lib/palazzo/fillers \
  -p 127.0.0.1:3100:3100 \
  -p 127.0.0.1:8000:8000 \
  -e PALAZZO_PORT=3100 \
  -e PALAZZO_INSTANCE_ID=palazzo-production \
  -e PROGRAM_ID="$program_id" \
  -e PALAZZO_CONTROL_TOKEN_FILE=/run/secrets/palazzo-control-token \
  -e ICECAST_PORT=8000 \
  -e ICECAST_SOURCE_PASSWORD="$icecast_source_password" \
  --restart=always \
  --log-driver=awslogs \
  --log-opt awslogs-region=us-east-1 \
  --log-opt awslogs-group=/services/palazzo \
  --log-opt "awslogs-stream=palazzo-$(date +%Y%m%dT%H%M%S)" \
  "$image"; then
  docker rm -f palazzo >/dev/null 2>&1 || true
  if [ "$rollback_available" = true ]; then
    docker rename palazzo-rollback palazzo
    docker start palazzo
  fi
  exit 1
fi
unset icecast_source_password

deployed_ready=false
for _ in $(seq 1 45); do
  if docker exec palazzo node -e 'fetch("http://127.0.0.1:3100/playback/state").then(async response=>{const state=await response.json();if(!response.ok||state.liquidsoap?.running!==true||state.liquidsoap?.connected!==true||state.icecast?.connected!==true)throw new Error("transport not ready")}).catch(error=>{console.error(error.message);process.exit(1)})'; then
    deployed_ready=true
    break
  fi
  sleep 2
done
if [ "$deployed_ready" != true ]; then
  echo 'Palazzo deployment failed its transport and lifecycle checks; rolling back'
  docker logs --tail 200 palazzo || true
  docker rm -f palazzo || true
  if [ "$rollback_available" = true ]; then
    docker rename palazzo-rollback palazzo
    docker start palazzo
  fi
  exit 1
fi

if [ "$rollback_available" = true ]; then
  docker rm palazzo-rollback
fi

printf '%s' "$nginx_config_base64" | base64 -d > /tmp/cumulus-palazzo.conf
install -m 0644 /tmp/cumulus-palazzo.conf /etc/nginx/conf.d/cumulus-palazzo.conf
rm -f /tmp/cumulus-palazzo.conf
nginx -t
systemctl reload nginx
certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d palazzo.gaulatti.com
systemctl enable --now certbot-renew.timer

stream_status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' https://palazzo.gaulatti.com || true)"
test "$stream_status" = 200
echo PALAZZO_HEALTHY
