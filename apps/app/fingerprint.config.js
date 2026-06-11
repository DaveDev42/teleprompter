// Stabilizes the expo-updates runtime version against files that CocoaPods
// writes INTO node_modules during `pod install` on the EAS builder. The
// builder recomputes the fingerprint AFTER prebuild + pod install and rejects
// the build if it disagrees with the value the workflow's fingerprint job
// computed from the clean checkout, so any pod-install-time mutation of a
// fingerprinted source dir breaks every iOS build.
//
// Known mutations covered here:
// - react-native-quick-crypto extracts the libsodium source tarball into its
//   own package dir during podspec evaluation when SODIUM_ENABLED=1
//   (QuickCrypto.podspec).
// - expo-modules-autolinking's precompiled-modules flow writes a patched
//   <PodName>.podspec.json next to the Ruby podspec of every third-party
//   library it serves from prebuilt xcframeworks (reanimated, screens,
//   safe-area-context, worklets — precompiled_modules.rb
//   generate_prepatched_podspec).
// - react-native-audio-api's RNAudioAPI.podspec prepare_command runs
//   scripts/download-prebuilt-binaries.sh during pod install, downloading
//   prebuilt audio binaries into common/cpp/audioapi/external/{iphoneos,
//   iphonesimulator}/ inside its own package dir.
//
// The `**/` prefix is required: @expo/fingerprint strips the `../../`
// monorepo prefix from source paths only for patterns starting with `**/`.
/** @type {import('@expo/fingerprint').Config} */
const config = {
  ignorePaths: [
    "**/node_modules/react-native-quick-crypto/ios/libsodium-stable/**",
    "**/node_modules/react-native-quick-crypto/ios/libsodium.tar.gz",
    "**/node_modules/**/*.podspec.json",
    "**/node_modules/react-native-audio-api/common/cpp/audioapi/external/**",
  ],
};

module.exports = config;
