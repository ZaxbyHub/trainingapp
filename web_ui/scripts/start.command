#!/usr/bin/env bash
# Launch Document Q&A offline edition (macOS / Linux)
cd "$(dirname "$0")"
echo ""
echo "  Starting Document Q&A offline server..."
echo ""

if ! command -v node &>/dev/null; then
    echo "  ERROR: Node.js is not installed."
    echo ""
    echo "  Install Node.js from https://nodejs.org (LTS version)"
    echo "  Then run this file again."
    echo ""
    read -p "  Press Enter to exit..."
    exit 1
fi

node ./serve-offline.mjs 8080
