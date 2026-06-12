// Fixes the EAS iOS build failure "'rnworklets/rnworklets.h' file not found".
//
// Root cause: react-native-audio-api's AudioAPIModule.mm does
//   #import <worklets/apple/WorkletsModule.h>   (under RN_AUDIO_API_ENABLE_WORKLETS=1)
// and that header transitively does
//   #import <rnworklets/rnworklets.h>
// which is NOT a static file — it is a ReactCodegen-generated umbrella header
// that lives at $(PODS_ROOT)/Headers/Public/ReactCodegen/rnworklets/rnworklets.h
// (a relative symlink into build/generated/ios/ReactCodegen/).
//
// RNAudioAPI.podspec adds $(PODS_ROOT)/Headers/Public/RNWorklets to its
// HEADER_SEARCH_PATHS but never adds the ReactCodegen path, so on a clean EAS
// builder this third-party pod — the first *external* consumer of
// WorkletsModule.h — cannot see the generated header and fails to compile.
// RNWorklets/RNReanimated own the same codegen pass, which is why builds passed
// before react-native-audio-api was added (PR #622) and failed after.
//
// This is the Expo-first / CNG-safe equivalent of upstream react-native-audio-api
// PR #1102 (issue #1095): we add the ReactCodegen header search paths to the
// RNAudioAPI pod target via a Podfile post_install hook. We inject INTO the
// existing react_native_post_install block rather than appending a second
// top-level `post_install` — CocoaPods keeps only one post_install callback, so
// a second block would silently clobber Expo's react_native_post_install.
const { withPodfile } = require("@expo/config-plugins");

const MARKER = "# [withAudioApiWorkletsHeaders]";

// Injected inside the existing `post_install do |installer| ... end` block,
// after the react_native_post_install(...) call. Adds the ReactCodegen header
// search paths to the RNAudioAPI pod target only.
const SNIPPET = `
    ${MARKER} begin — make ReactCodegen-generated <rnworklets/rnworklets.h> visible to RNAudioAPI
    installer.pods_project.targets.each do |target|
      next unless target.name == "RNAudioAPI"
      target.build_configurations.each do |config|
        existing = config.build_settings["HEADER_SEARCH_PATHS"] || "$(inherited)"
        existing = existing.join(" ") if existing.is_a?(Array)
        next if existing.include?("Headers/Public/ReactCodegen")
        config.build_settings["HEADER_SEARCH_PATHS"] = [
          existing,
          '"$(PODS_ROOT)/Headers/Public/ReactCodegen"',
          '"$(PODS_ROOT)/Headers/Private/ReactCodegen"',
          '"$(PODS_ROOT)/../build/generated/ios/ReactCodegen"',
        ].join(" ")
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
