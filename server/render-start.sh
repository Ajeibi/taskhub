#!/bin/sh
# Render start command (single instance): apply migrations, then hand PID 1 to the server so SIGTERM reaches it.
# Kept as a file because Render passes quotes in dockerCommand through literally.
set -e
node dist/migrate-cli.js
exec node dist/index.js
