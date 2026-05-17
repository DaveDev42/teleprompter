import type { PermissionResponse } from "expo-modules-core";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { ariaLevel, getPlatformProps } from "../../src/lib/get-platform-props";
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

// ---------------------------------------------------------------------------
// Web-only camera QR scan hook
// ---------------------------------------------------------------------------

type WebScanState =
  | "requesting"
  | "active"
  | "denied"
  | "unsupported"
  | "decoded";

// BarcodeDetector is a browser-native API not yet in the standard TypeScript
// DOM lib. Declare a minimal interface so we can use it without `any` casts
// everywhere, while still falling through to jsQR on browsers that lack it.
interface BarcodeDetectorResult {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<BarcodeDetectorResult[]>;
}
interface BarcodeDetectorConstructor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

/**
 * Web-only hook that drives the camera → BarcodeDetector / jsQR pipeline.
 * Returns a ref to attach to the <video> element and the current scan state.
 *
 * Detection runs at ~10 fps via `requestAnimationFrame` + a 100 ms cooldown
 * to avoid burning CPU on a busy tab.
 *
 * Priority:
 *   1. `window.BarcodeDetector` (Chromium ≥83, Edge, Brave)
 *   2. Dynamic `import("jsqr")` → canvas snapshot (Firefox, Safari)
 *
 * All side-effects are confined to `useEffect` and are cleaned up on unmount.
 * The hook is a no-op when `enabled` is false (native code path).
 */
function useWebCameraScan(
  onDecoded: (data: string) => void,
  enabled: boolean,
): {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  scanState: WebScanState;
} {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [scanState, setScanState] = useState<WebScanState>("requesting");
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Keep a stable callback ref so the rAF loop never stales over `onDecoded`.
  const onDecodedRef = useRef(onDecoded);
  useEffect(() => {
    onDecodedRef.current = onDecoded;
  }, [onDecoded]);

  useEffect(() => {
    if (!enabled) return;
    mountedRef.current = true;

    // Lazily allocate the hidden canvas used by the jsQR fallback.
    const canvas = document.createElement("canvas");
    canvas.style.display = "none";
    document.body.appendChild(canvas);
    canvasRef.current = canvas;

    type JsQRFn = (
      data: Uint8ClampedArray,
      width: number,
      height: number,
    ) => { data: string } | null;

    let detector: BarcodeDetectorLike | null = null;
    let jsQrFn: JsQRFn | null = null;
    let setupDone = false;

    // Build the detector once — BarcodeDetector preferred, jsQR fallback.
    async function setupDetector() {
      const BD = (window as unknown as Record<string, unknown>)
        .BarcodeDetector as BarcodeDetectorConstructor | undefined;

      if (BD) {
        try {
          // Verify QR support before constructing to avoid silent failures on
          // browsers that support BarcodeDetector but not qr_code format.
          const supported: string[] = (await BD.getSupportedFormats?.()) ?? [];
          if (supported.length === 0 || supported.includes("qr_code")) {
            detector = new BD({ formats: ["qr_code"] });
            return;
          }
        } catch {
          // getSupportedFormats may not exist in all implementations.
          try {
            detector = new BD({ formats: ["qr_code"] });
            return;
          } catch {
            // Fall through to jsQR.
          }
        }
      }

      // jsQR fallback (Firefox, Safari, older Chromium).
      try {
        const mod = await import("jsqr");
        // Handle both CJS default-export shapes produced by bundlers.
        const candidate = (mod as { default?: unknown }).default ?? mod;
        if (typeof candidate === "function") {
          jsQrFn = candidate as JsQRFn;
        }
      } catch {
        // jsQR unavailable — scanning UI will still appear but decode silently
        // fails (user is shown the viewfinder but QR won't trigger).
      }
    }

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (!mountedRef.current) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        await setupDetector();
        setupDone = true;
        if (mountedRef.current) {
          setScanState("active");
          scheduleFrame();
        }
      } catch (err) {
        if (!mountedRef.current) return;
        const name = err instanceof Error ? err.name : "";
        if (
          name === "NotAllowedError" ||
          name === "PermissionDeniedError" ||
          name === "SecurityError"
        ) {
          setScanState("denied");
        } else {
          setScanState("unsupported");
        }
      }
    }

    function stopStream() {
      cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop();
      }
      streamRef.current = null;
    }

    async function detectFrame() {
      const video = videoRef.current;
      if (!video || video.readyState < 2 /* HAVE_CURRENT_DATA */) return;

      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;

      let decoded: string | null = null;

      if (detector) {
        try {
          const results = await detector.detect(video);
          if (results.length > 0) decoded = results[0].rawValue;
        } catch {
          // Transient errors (video not ready, frame mid-update) — ignore.
        }
      } else if (jsQrFn) {
        const cv = canvasRef.current;
        if (!cv) return;
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const result = jsQrFn(imageData.data, w, h);
        if (result) decoded = result.data;
      }

      if (decoded) {
        stopStream();
        setScanState("decoded");
        onDecodedRef.current(decoded);
      }
    }

    function scheduleFrame() {
      rafRef.current = requestAnimationFrame(async (ts) => {
        if (!mountedRef.current) return;
        // Throttle to ~10 fps (100 ms minimum between frames).
        if (ts - lastFrameRef.current >= 100) {
          lastFrameRef.current = ts;
          if (setupDone) await detectFrame();
        }
        scheduleFrame();
      });
    }

    if (
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices !== "undefined" &&
      typeof navigator.mediaDevices.getUserMedia === "function"
    ) {
      startCamera();
    } else {
      setScanState("unsupported");
    }

    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop();
      }
      streamRef.current = null;
      if (canvasRef.current) {
        canvasRef.current.remove();
        canvasRef.current = null;
      }
    };
  }, [enabled]);

  return { videoRef, scanState };
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
 *
 * On web: uses `BarcodeDetector` (Chromium) with jsQR canvas fallback (Firefox /
 * Safari). Camera permission denial or missing camera shows a "Enter pairing
 * code manually" CTA that routes to /pairing.
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

  // ---------------------------------------------------------------------------
  // Web camera branch
  // ---------------------------------------------------------------------------

  // Web-only: handle a decoded QR URL from the camera pipeline, mirroring
  // the exact success path used by the native handleScanned callback.
  const handleWebDecoded = useCallback(
    async (data: string) => {
      if (handlingRef.current) return;
      handlingRef.current = true;
      setScanError(null);

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

  // Only run the web camera hook on web. Pass enabled=false on native so no
  // effects fire inside the hook. The hook body is also individually guarded
  // by `enabled`, so this is belt-and-suspenders.
  const webScanEnabled = Platform.OS === "web";
  const { videoRef, scanState } = useWebCameraScan(
    handleWebDecoded,
    webScanEnabled,
  );

  // ---------------------------------------------------------------------------
  // Web render
  // ---------------------------------------------------------------------------

  if (Platform.OS === "web") {
    const showFallback = scanState === "denied" || scanState === "unsupported";
    const showCamera = !showFallback && scanState !== "decoded";

    const fallbackMessage =
      scanState === "denied"
        ? "Camera access was denied. You can still pair by entering the pairing code manually."
        : "Camera is not available in this browser. You can still pair by entering the pairing code manually.";

    return (
      <View
        className="flex-1 bg-tp-bg items-center justify-center"
        // WCAG 2.4.1 Bypass Blocks (Level A): expose the scan screen body as
        // the main landmark so AT users can jump straight to controls. This
        // branch only renders on web (see the if-guard above), so the role
        // prop is safe to set directly without a Platform.OS spread.
        role="main"
      >
        {showCamera && (
          <View className="w-full max-w-md px-4" testID="scan-web-viewfinder">
            {/* Status live region announced while camera is initialising. */}
            <View
              testID="scan-web-status"
              accessibilityLiveRegion="polite"
              {...(Platform.OS === "web"
                ? ({ role: "status", "aria-live": "polite" } as object)
                : {})}
              className="items-center mb-4"
            >
              <Text className="text-tp-text-secondary text-sm text-center">
                {scanState === "requesting"
                  ? "Requesting camera access…"
                  : scanState === "active"
                    ? "Point the camera at the QR code"
                    : scanState === "decoded"
                      ? "QR code detected!"
                      : ""}
              </Text>
            </View>

            {/* Camera viewfinder — rendered as a plain DOM <video> element.
                React Native Web supports raw HTML intrinsics inside Platform.OS
                === "web" branches; the element never reaches the native RN
                renderer because of the early return above. */}
            <View
              className="w-full rounded-card overflow-hidden bg-tp-bg-input"
              style={{ aspectRatio: 1, maxWidth: 400 }}
            >
              <video
                ref={videoRef as React.RefObject<HTMLVideoElement>}
                autoPlay
                playsInline
                muted
                aria-label="Camera viewfinder for QR scan"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                }}
              />
            </View>

            {scanError && (
              <View
                role="alert"
                className="mt-4 bg-tp-error/20 border border-tp-error rounded-lg px-4 py-3"
              >
                <Text className="text-tp-error text-sm">{scanError}</Text>
              </View>
            )}

            <View className="flex-row gap-3 mt-4 justify-center">
              <Pressable
                onPress={() => router.push("/pairing")}
                accessibilityRole="button"
                accessibilityLabel="Enter pairing code manually"
                tabIndex={pp.tabIndex}
                testID="scan-web-manual-fallback"
                className={`bg-tp-bg-input px-5 py-3 rounded-full border border-tp-border ${pp.className}`}
              >
                <Text className="text-tp-text-primary text-sm">
                  Enter code manually
                </Text>
              </Pressable>
              <Pressable
                onPress={goBack}
                accessibilityRole="button"
                accessibilityLabel="Go back"
                tabIndex={pp.tabIndex}
                testID="scan-web-go-back"
                className={`bg-tp-bg-input px-5 py-3 rounded-full border border-tp-border ${pp.className}`}
              >
                <Text className="text-tp-text-primary text-sm">Go Back</Text>
              </Pressable>
            </View>
          </View>
        )}

        {showFallback && (
          <View className="w-full max-w-md px-6 items-center">
            <Text
              accessibilityRole="header"
              {...ariaLevel(1)}
              className="text-tp-text-secondary text-lg font-semibold text-center mb-4"
            >
              Camera unavailable
            </Text>
            <Text
              testID="scan-web-fallback-message"
              className="text-tp-text-tertiary text-center text-sm mb-6"
            >
              {fallbackMessage}
            </Text>
            <Pressable
              onPress={() => router.push("/pairing")}
              accessibilityRole="button"
              accessibilityLabel="Enter pairing code manually"
              tabIndex={pp.tabIndex}
              testID="scan-web-manual-fallback"
              className={`bg-tp-accent px-6 py-3 rounded-full ${pp.className}`}
            >
              <Text className="text-tp-text-on-color font-semibold">
                Enter pairing code manually
              </Text>
            </Pressable>
            <Pressable
              onPress={goBack}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              tabIndex={pp.tabIndex}
              testID="scan-web-go-back"
              className={`mt-3 bg-tp-bg-input px-6 py-2 rounded-lg ${pp.className}`}
            >
              <Text className="text-tp-text-primary">Go Back</Text>
            </Pressable>
          </View>
        )}

        {scanState === "decoded" && (
          <View
            testID="scan-web-processing"
            accessibilityLiveRegion="polite"
            {...(Platform.OS === "web"
              ? ({ role: "status", "aria-live": "polite" } as object)
              : {})}
            className="items-center"
          >
            <Text className="text-tp-text-secondary">Processing QR code…</Text>
          </View>
        )}
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // Native render (unchanged)
  // ---------------------------------------------------------------------------

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
