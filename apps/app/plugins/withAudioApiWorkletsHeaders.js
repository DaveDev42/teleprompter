// Fixes two EAS iOS build failures introduced by react-native-audio-api (#622),
// both header-search-path gaps in the RNAudioAPI pod target on a clean builder.
//
// Stage 1 — "'rnworklets/rnworklets.h' file not found":
//   AudioAPIModule.mm does `#import <worklets/apple/WorkletsModule.h>` (under
//   RN_AUDIO_API_ENABLE_WORKLETS=1), which transitively imports
//   `#import <rnworklets/rnworklets.h>` — NOT a static file but a
//   ReactCodegen-generated umbrella header at
//   $(PODS_ROOT)/Headers/Public/ReactCodegen/rnworklets/rnworklets.h (a symlink
//   into build/generated/ios/ReactCodegen/). RNAudioAPI.podspec adds the
//   RNWorklets header path but never the ReactCodegen path, so RNAudioAPI — the
//   first *external* consumer of WorkletsModule.h — can't see it. RNWorklets /
//   RNReanimated own that codegen pass, which is why builds passed before
//   react-native-audio-api and failed after. Expo-first / CNG-safe equivalent of
//   upstream react-native-audio-api PR #1102 (issue #1095).
//
// Stage 2 — "'audioapi/core/...' file not found" (WorkletsRunner.h,
//   WorkletSourceNode.h): react-native-audio-api PR #862 (shipped in 0.12.x)
//   removed `$(PODS_TARGET_SRCROOT)/common/cpp` from the pod's
//   pod_target_xcconfig HEADER_SEARCH_PATHS and switched to a headermap-only
//   strategy (USE_HEADERMAP=YES + header_mappings_dir). On EAS's clean builder
//   the headermap fails to resolve the worklets-subtree `#include <audioapi/...>`
//   forms (e.g. BaseAudioContext.cpp's unconditional include of
//   <audioapi/core/sources/WorkletSourceNode.h>), and with no `common/cpp`
//   search path the direct-lookup fallback also fails. RNAudioAPI is NOT among
//   Expo's precompiled modules (only Expo's own pods are) — it compiles from
//   source, so restoring the source-root search path is the correct fix. We add
//   $(PODS_TARGET_SRCROOT)/common/cpp back, restoring pre-PR#862 behavior.
//
// Both fixes inject INTO the existing react_native_post_install block rather
// than appending a second top-level `post_install` — CocoaPods keeps only one
// post_install callback, so a second block would silently clobber Expo's
// react_native_post_install.
const { withPodfile } = require("@expo/config-plugins");

const MARKER = "# [withAudioApiWorkletsHeaders]";

// Injected inside the existing `post_install do |installer| ... end` block,
// after the react_native_post_install(...) call. Adds (1) the ReactCodegen
// header search paths and (2) the pod's own common/cpp source root to the
// RNAudioAPI pod target only. Per-config Ruby guards keep it idempotent across
// repeated `pod install` runs; each path is added only if absent.
const SNIPPET = `
    ${MARKER} begin — restore header search paths RNAudioAPI needs on a clean builder
    installer.pods_project.targets.each do |target|
      next unless target.name == "RNAudioAPI"
      target.build_configurations.each do |config|
        existing = config.build_settings["HEADER_SEARCH_PATHS"] || "$(inherited)"
        existing = existing.join(" ") if existing.is_a?(Array)
        additions = []
        # Stage 1: ReactCodegen-generated <rnworklets/rnworklets.h> (issue #1095)
        unless existing.include?("Headers/Public/ReactCodegen")
          additions += [
            '"$(PODS_ROOT)/Headers/Public/ReactCodegen"',
            '"$(PODS_ROOT)/Headers/Private/ReactCodegen"',
            '"$(PODS_ROOT)/../build/generated/ios/ReactCodegen"',
          ]
        end
        # Stage 2: the pod's own <audioapi/core/...> source root (post-PR#862)
        unless existing.include?("PODS_TARGET_SRCROOT)/common/cpp")
          additions << '"$(PODS_TARGET_SRCROOT)/common/cpp"'
        end
        next if additions.empty?
        config.build_settings["HEADER_SEARCH_PATHS"] = [existing, *additions].join(" ")
      end
    end
    ${MARKER} end
`;

module.exports = function withAudioApiWorkletsHeaders(config) {
  return withPodfile(config, (mod) => {
    const contents = mod.modResults.contents;
    if (contents.includes(MARKER)) {
      return mod; // idempotent — already injected
    }

    // Find the closing paren of the react_native_post_install(...) call and
    // insert our snippet immediately after it, staying inside the same
    // `post_install do |installer|` block.
    const callMatch = contents.match(
      /react_native_post_install\([\s\S]*?\n\s*\)\n/,
    );
    if (!callMatch) {
      throw new Error(
        "[withAudioApiWorkletsHeaders] could not locate the react_native_post_install(...) call in the Podfile; the post_install structure changed — update this plugin.",
      );
    }

    const insertAt = callMatch.index + callMatch[0].length;
    mod.modResults.contents =
      contents.slice(0, insertAt) + SNIPPET + contents.slice(insertAt);
    return mod;
  });
};
