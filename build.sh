#!/usr/bin/env bash
# Build script: compiles JSX in index-dev.html → index.html (production)
# Usage: ./build.sh  (or: node build.js)
# Requires: node + npm

set -euo pipefail
cd "$(dirname "$0")"

# Install Babel if needed
if [ ! -d "build_deps/node_modules/@babel/core" ]; then
    echo "Installing Babel (one-time)..."
    mkdir -p build_deps
    (cd build_deps && npm init -y --silent > /dev/null 2>&1 && npm install --silent @babel/core @babel/preset-react 2>&1 | tail -1)
fi

node build.js
