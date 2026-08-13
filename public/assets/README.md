Drop your actual binary assets here, matching the paths declared in src/assets.ts:

  textures/  .png / .jpg files      -> loaded via AssetLoader.loadTexture / libTex
  models/    .glb files             -> loaded via AssetLoader.loadGlb / libGlb
  audio/     .mp3 / .wav files      -> loaded via AssetLoader.loadAudio / libAudio
  fonts/     three.js typeface json -> libFont

This folder is copied as-is into dist/assets during a production build so
paths keep working after bundling (assets.ts paths are plain strings, not
bundler imports, precisely so this copy-verbatim step works).
