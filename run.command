#!/bin/bash
# Double-click this in Finder to launch Warble (backend + frontend).
# Just a thin wrapper around run.sh — macOS Finder only double-click-runs
# .command files, not .sh files, so this is the click-to-launch entry point;
# run.sh stays the one with the actual logic (also usable from a terminal).
cd "$(dirname "$0")"
./run.sh
