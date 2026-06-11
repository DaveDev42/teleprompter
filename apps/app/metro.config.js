const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch all monorepo packages (merge with Expo defaults)
config.watchFolders = [...(config.watchFolders || []), monorepoRoot];

// Resolve modules from both project and monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Remove deprecated option set by Expo's default config
if (config.watcher) {
  delete config.watcher.unstable_workerThreads;
}

// ghostty-web's UMD build ships as a bundled .txt asset for the native
// WebView terminal (assets/ghostty-web.umd.txt — see GhosttyNative.tsx).
// "txt" is not in Metro's default assetExts.
config.resolver.assetExts = [...config.resolver.assetExts, "txt"];

module.exports = withNativeWind(config, { input: "./global.css" });
