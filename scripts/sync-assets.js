#!/usr/bin/env node
// Copies assets/ -> public/assets/ so the dev server can serve real
// texture/model/audio files at the same relative paths used in
// src/game/assets.ts. Plain Node (no shell-specific commands) so it works
// the same on macOS, Linux, and Windows.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "assets");
const dest = path.join(__dirname, "..", "public", "assets");

function copyRecursive(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const fromPath = path.join(from, entry.name);
    const toPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(fromPath, toPath);
    } else {
      fs.copyFileSync(fromPath, toPath);
    }
  }
}

if (fs.existsSync(src)) {
  copyRecursive(src, dest);
  console.log(`Synced assets/ -> public/assets/`);
} else {
  console.log("No assets/ folder found, skipping sync.");
}

// Also copy the UI editor into public/ so the dev server (which only
// serves public/) can reach it at /ui-editor.html for the "Edit UI" button.
const uiEditorSrc = path.join(__dirname, "..", "tools", "ui-editor.html");
const uiEditorDest = path.join(__dirname, "..", "public", "ui-editor.html");
if (fs.existsSync(uiEditorSrc)) {
  fs.copyFileSync(uiEditorSrc, uiEditorDest);
  console.log("Synced tools/ui-editor.html -> public/ui-editor.html");
}
