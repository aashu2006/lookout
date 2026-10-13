#!/bin/sh
# Start command for hosts that give one container and no shell (Render free
# tier): migrate, optionally seed, then run the api with the worker embedded.
# Docker Compose does not use this; it sets its own commands per service.
set -e

npx prisma migrate deploy

if [ "$SEED_ON_BOOT" = "true" ]; then
  # The seed exits 1 when the demo user already exists, which is every boot
  # after the first. That must not stop the api from starting.
  node dist/scripts/seed.js || true
fi

# exec so node is PID 1 and receives SIGTERM directly.
exec node dist/server.js
