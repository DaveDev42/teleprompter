import type { PermissionResponse } from "expo-modules-core";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
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
  const [scanError, setScanError] = useState<string | null>(null);
  // Drop late processScan results if the user already cancelled out.
  const mountedRef = useRef(true);
  // Dedup so a quick double-detect from VisionKit doesn't fire processScan
  // twice before navigation.
  const handlingRef = useRef(false);
  // Whether the OS scanner modal is currently up. Used to suppress relaunch
  // loops if `launchScanner` fails sync.
  const launchedRef = useRef(false);

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

  const handleScanned = useCallback(
    async (data: string) => {
      if (handlingRef.current) return;
      handlingRef.current = true;
      setScanError(null);

      // Tear the modal down so it doesn't keep firing while we process.
      await CameraView?.dismissScanner().catch(() => {});
      launchedRef.current = false;

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
  // OS scanner. Listener stays alive across retries (Try Again button).
  useEffect(() => {
    if (Platform.OS === "web") return;
    if (!CameraView) return;
    if (!permission?.granted) return;
    if (!CameraView.isModernBarcodeScannerAvailable) return;

    const sub = CameraView.onModernBarcodeScanned((event) => {
      if (event?.data) handleScanned(event.data);
    });

    if (!launchedRef.current) {
      launchedRef.current = true;
      CameraView.launchScanner({ barcodeTypes: ["qr"] }).catch(() => {
        launchedRef.current = false;
        if (mountedRef.current) {
          setScanError("Could not open the camera scanner.");
        }
      });
    }

    return () => {
      sub.remove();
      CameraView?.dismissScanner().catch(() => {});
      launchedRef.current = false;
    };
  }, [permission?.granted, handleScanned]);

  const retry = useCallback(() => {
    if (Platform.OS === "web" || !CameraView) return;
    setScanError(null);
    handlingRef.current = false;
    if (launchedRef.current) return;
    launchedRef.current = true;
    CameraView.launchScanner({ barcodeTypes: ["qr"] }).catch(() => {
      launchedRef.current = false;
      if (mountedRef.current) {
        setScanError("Could not open the camera scanner.");
      }
    });
  }, []);

  if (Platform.OS === "web") {
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <Text className="text-gray-400">
          QR scanning is not available on web.
        </Text>
        <Pressable
          onPress={() => router.back()}
          className="mt-4 bg-zinc-800 px-6 py-2 rounded-lg"
        >
          <Text className="text-white">Go Back</Text>
        </Pressable>
      </View>
    );
  }

  if (!CameraView) {
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <Text className="text-gray-400">Camera not available</Text>
      </View>
    );
  }

  if (!permission?.granted) {
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <Text className="text-gray-400 text-center px-8">
          Camera permission is required to scan QR codes.
        </Text>
        <Pressable
          onPress={requestPermission}
          className="mt-4 bg-blue-600 px-6 py-2 rounded-lg"
        >
          <Text className="text-white">Grant Permission</Text>
        </Pressable>
      </View>
    );
  }

  // The OS scanner is presented as a modal on top of this view, so the user
  // never actually sees this background. It's here as fallback for the rare
  // device where `isModernBarcodeScannerAvailable === false` (iOS <16, certain
  // Android OEMs without Google Play Services), and as the surface that holds
  // the error/retry/cancel UI when the modal is dismissed.
  return (
    <View className="flex-1 bg-black items-center justify-center px-6">
      {!CameraView.isModernBarcodeScannerAvailable ? (
        <Text className="text-gray-400 text-center">
          QR scanning isn't available on this device. Please update to iOS 16 or
          newer, or paste the pairing link manually.
        </Text>
      ) : scanError ? (
        <View className="w-full bg-tp-error rounded-card px-4 py-3 mb-6">
          <Text className="text-white text-[13px] font-semibold mb-1">
            Pairing failed
          </Text>
          <Text className="text-white/90 text-xs">{scanError}</Text>
        </View>
      ) : (
        <Text className="text-gray-400">Opening scanner…</Text>
      )}

      <View className="flex-row gap-3 mt-4">
        {scanError && CameraView.isModernBarcodeScannerAvailable ? (
          <Pressable
            onPress={retry}
            className="bg-blue-600 px-6 py-3 rounded-full"
          >
            <Text className="text-white">Try again</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => router.back()}
          className="bg-black/70 px-6 py-3 rounded-full border border-white/20"
        >
          <Text className="text-white">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
