import type { PermissionResponse } from "expo-modules-core";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { getPlatformProps } from "../../src/lib/get-platform-props";
import { usePairingStore } from "../../src/stores/pairing-store";

// Native-only API surface from expo-camera. We avoid `import` at module top so
// the web bundle does not pull in the native module.
type ScanningResult = { data: string; type: string };
type ScanningOptions = {
  barcodeTypes: string[];
  isPinchToZoomEnabled?: boolean;
};
interface CameraStatic {
  isModernBarcodeScannerAvailable: boolean;
  launchScanner: (options?: ScanningOptions) => Promise<void>;
  dismissScanner: () => Promise<void>;
  onModernBarcodeScanned: (listener: (event: ScanningResult) => void) => {
    remove: () => void;
  };
}

type UseCameraPermissionsHook = () => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
];

let CameraView: CameraStatic | null = null;
let useCameraPermissions: UseCameraPermissionsHook | null = null;

if (Platform.OS !== "web") {
  try {
    const cam = require("expo-camera");
    CameraView = cam.CameraView;
    useCameraPermissions = cam.useCameraPermissions;
  } catch {
    // expo-camera not available
  }
}

/**
 * QR pairing scan screen.
 *
 * Uses expo-camera's "modern" scanner — `CameraView.launchScanner()` — which
 * presents iOS 16+ `DataScannerViewController` (the same VisionKit engine that
 * powers the system Camera app) and Android Google ML Kit code scanner. This
 * is materially better at decoding dense QR codes than the in-app `CameraView`
 * preview (which uses the older `AVCaptureMetadataOutput` on iOS) and matches
 * what the user sees when they scan with the system camera.
 *
 * No camera preview is rendered here — `launchScanner` is a full-screen modal
 * controlled by the OS. We only render fallback UI (permission ask, "scanner
 * unavailable" notice on iOS <16 or unsupported Android, web).
 */
export default function ScanScreen() {
  const router = useRouter();
  const processScan = usePairingStore((s) => s.processScan);
  const pp = getPlatformProps();
  const [scanError, setScanError] = useState<string | null>(null);
  // Tracks whether the OS scanner modal is currently visible. Goes false in
  // three cases: (a) user scanned a code (handleScanned tears it down),
  // (b) user swipe-dismissed the modal (launchScanner resolves normally),
  // (c) launchScanner threw. Drives the "Tap to scan again" retry UI.
  const [scannerOpen, setScannerOpen] = useState(false);
  // Drop late processScan results if the user already cancelled out.
  const mountedRef = useRef(true);
  // Dedup so a quick double-detect from VisionKit doesn't fire processScan
  // twice before navigation.
  const handlingRef = useRef(false);
  // Monotonic counter that identifies the "current" launchScanner call.
  // A parent remount re-running the lifecycle effect, or a retry tapped
  // while a prior launch is still pending, can leave a stale launchScanner
  // promise in flight. When it eventually resolves we must not let it stomp
  // on the newer launch's `scannerOpen` state.
  const launchIdRef = useRef(0);

  const [permission, requestPermission] = useCameraPermissions?.() ?? [
    null,
    (() => {}) as () => Promise<PermissionResponse>,
  ];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (permission && !permission.granted) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  // Open the OS scanner modal. Wraps both the open call and resolution
  // bookkeeping so the lifecycle effect and the retry button share one path.
  const openScanner = useCallback(() => {
    if (!CameraView) return;
    const id = ++launchIdRef.current;
    setScannerOpen(true);
    CameraView.launchScanner({ barcodeTypes: ["qr"] })
      .then(() => {
        // Resolves when the modal dismisses for any reason — scan, swipe-down,
        // programmatic dismiss. The handleScanned path will already have set
        // scannerOpen=false; this no-ops in that case. The id check drops a
        // stale resolution from a prior launch so it doesn't flip a newer
        // launch's state to closed.
        if (mountedRef.current && launchIdRef.current === id) {
          setScannerOpen(false);
        }
      })
      .catch(() => {
        if (mountedRef.current && launchIdRef.current === id) {
          setScannerOpen(false);
          setScanError("Could not open the camera scanner.");
        }
      });
  }, []);

  const handleScanned = useCallback(
    async (data: string) => {
      if (handlingRef.current) return;
      handlingRef.current = true;
      setScanError(null);

      // Tear the modal down so it doesn't keep firing while we process.
      await CameraView?.dismissScanner().catch(() => {});
      setScannerOpen(false);

      await processScan(data);
      if (!mountedRef.current) return;
      const { state, error } = usePairingStore.getState();
      if (state === "paired") {
        router.replace("/");
        return;
      }
      setScanError(error ?? "Could not read pairing data from this QR code.");
      handlingRef.current = false;
    },
    [processScan, router],
  );

  // Subscribe to scan events for the lifetime of the screen, then launch the
  // OS scanner once permissions are ready.
  useEffect(() => {
    if (Platform.OS === "web") return;
    if (!CameraView) return;
    if (!permission?.granted) return;
    if (!CameraView.isModernBarcodeScannerAvailable) return;

    const sub = CameraView.onModernBarcodeScanned((event) => {
      if (event?.data) handleScanned(event.data);
    });

    openScanner();

    return () => {
      sub.remove();
      CameraView?.dismissScanner().catch(() => {});
    };
  }, [permission?.granted, handleScanned, openScanner]);

  const retry = useCallback(() => {
    if (Platform.OS === "web" || !CameraView) return;
    setScanError(null);
    handlingRef.current = false;
    if (scannerOpen) return;
    openScanner();
  }, [openScanner, scannerOpen]);

  // canGoBack() guards the case where the user opens /pairing/scan directly
  // (deep link, browser refresh) — router.back() is a no-op when there's no
  // history entry, leaving the user stranded on this dead-end screen.
  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace("/(tabs)/");

  if (Platform.OS === "web") {
    return (
      <View className="flex-1 bg-tp-bg items-center justify-center">
        <Text accessibilityRole="header" className="text-tp-text-secondary">
          QR scanning is not available on web.
        </Text>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          tabIndex={pp.tabIndex}
          className={`mt-4 bg-tp-bg-input px-6 py-2 rounded-lg ${pp.className}`}
        >
          <Text className="text-tp-text-primary">Go Back</Text>
        </Pressable>
      </View>
    );
  }

  if (!CameraView) {
    return (
      <View className="flex-1 bg-tp-bg items-center justify-center">
        <Text className="text-tp-text-secondary">Camera not available</Text>
      </View>
    );
  }

  if (!permission?.granted) {
    return (
      <View className="flex-1 bg-tp-bg items-center justify-center">
        <Text className="text-tp-text-secondary text-center px-8">
          Camera permission is required to scan QR codes.
        </Text>
        <Pressable
          onPress={requestPermission}
          accessibilityRole="button"
          accessibilityLabel="Grant camera permission"
          tabIndex={pp.tabIndex}
          className={`mt-4 bg-tp-accent px-6 py-2 rounded-lg ${pp.className}`}
        >
          <Text className="text-tp-text-on-color">Grant Permission</Text>
        </Pressable>
      </View>
    );
  }

  // The OS scanner is presented as a modal on top of this view, so the user
  // never actually sees this background. It's here as fallback for the rare
  // device where `isModernBarcodeScannerAvailable === false` (iOS <16, certain
  // Android OEMs without Google Play Services), and as the surface that holds
  // the error/retry/cancel UI when the modal is dismissed (either by
  // swipe-down or after a failed scan).
  const modernAvailable = CameraView.isModernBarcodeScannerAvailable;
  // Show the retry button whenever the modal is closed and the device
  // supports the modern scanner — covers both the post-error path and a
  // user-initiated swipe-down dismiss with no error.
  const showRetry = modernAvailable && !scannerOpen;
  return (
    <View className="flex-1 bg-tp-bg items-center justify-center px-6">
      {!modernAvailable ? (
        <Text className="text-tp-text-secondary text-center">
          QR scanning isn't available on this device. Please update to iOS 16 or
          newer, or paste the pairing link manually.
        </Text>
      ) : scanError ? (
        <View className="w-full bg-tp-error rounded-card px-4 py-3 mb-6">
          <Text className="text-tp-text-on-color text-[13px] font-semibold mb-1">
            Pairing failed
          </Text>
          <Text className="text-tp-text-on-color/90 text-xs">{scanError}</Text>
        </View>
      ) : scannerOpen ? (
        <Text className="text-tp-text-secondary">Opening scanner…</Text>
      ) : (
        <Text className="text-tp-text-secondary text-center">
          Scanner closed. Tap "Scan again" or paste the pairing link.
        </Text>
      )}

      <View className="flex-row gap-3 mt-4">
        {showRetry ? (
          <Pressable
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel={scanError ? "Try again" : "Scan again"}
            tabIndex={pp.tabIndex}
            className={`bg-tp-accent px-6 py-3 rounded-full ${pp.className}`}
          >
            <Text className="text-tp-text-on-color">
              {scanError ? "Try again" : "Scan again"}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          tabIndex={pp.tabIndex}
          className={`bg-tp-bg-input px-6 py-3 rounded-full border border-tp-border ${pp.className}`}
        >
          <Text className="text-tp-text-primary">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
