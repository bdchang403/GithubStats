#!/bin/bash
# Start the Node.js server for the dashboard
echo "Stopping any existing server..."
pkill -f "node server.js" || true
sleep 1

echo "Starting server..."
nohup node server.js > server.log 2>&1 &
echo "Server started. Logs in server.log"
echo "Dashboard server started with PID $!"
echo "Open http://localhost:8080/ to view the dashboard."
