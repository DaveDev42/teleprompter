import type { PermissionResponse } from "expo-modules-core";
import { useRouter } from "expo-router";
import type { ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { usePairingStore } from "../../src/stores/pairing-store";

// Dynamic import for camera (native only)
/** Props subset of CameraView that we use */
interface CameraViewLikeProps {
  style?: Record<string, unknown>;
  barcodeScannerSettings?: { barcodeTypes: string[] };
  onBarcodeScanned?: ((result: { data: string }) => void) | undefined;
  // iOS-only: expo-camera defaults autofocus to "off", which leaves the lens
  // on a hyperfocal-ish setting that is too coarse to resolve dense QR codes
  // (~80x80 modules). Without this, scanning the terminal QR silently fails
  // even though iOS's system Camera reads the same code instantly. Android
  // CameraX uses continuous AF natively for barcode mode, so the prop is
  // silently ignored there — leaving it on doesn't hurt cross-platform.
  autofocus?: "on" | "off";
}

type UseCameraPermissionsHook = () => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
];

let CameraView: ComponentType<CameraViewLikeProps> | null = null;
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

export default function ScanScreen() {
  const router = useRouter();
  const processScan = usePairingStore((s) => s.processScan);
  const [scanError, setScanError] = useState<string | null>(null);
  // Ref-based dedup so the camera's continuous detection loop only triggers
  // processScan once per QR even if the JS re-renders before we navigate away.
  const scanningRef = useRef(false);
  // Drop late processScan results if the user already cancelled out.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Camera permissions (native only)
  const [permission, requestPermission] = useCameraPermissions?.() ?? [
    null,
    (() => {}) as () => Promise<PermissionResponse>,
  ];

  useEffect(() => {
    if (permission && !permission.granted) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  // Stable callback so CameraView doesn't re-bind the listener on each render.
  const handleBarCodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (scanningRef.current) return;
      scanningRef.current = true;
      setScanError(null);

      await processScan(data);
      if (!mountedRef.current) return;
      const { state, error } = usePairingStore.getState();
      if (state === "paired") {
        router.replace("/");
        return;
      }
      // Surface the failure inline and re-arm the scanner so the user can
      // retry without leaving the screen.
      setScanError(error ?? "Could not read pairing data from this QR code.");
      scanningRef.current = false;
    },
    [processScan, router],
  );

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

  if (!CameraView) {
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <Text className="text-gray-400">Camera not available</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <CameraView
        style={{ flex: 1 }}
        autofocus="on"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={handleBarCodeScanned}
      />
      {scanError ? (
        <View className="absolute top-16 left-4 right-4 bg-tp-error rounded-card px-4 py-3">
          <Text className="text-white text-[13px] font-semibold mb-1">
            Pairing failed
          </Text>
          <Text className="text-white/90 text-xs">{scanError}</Text>
        </View>
      ) : null}
      <View className="absolute bottom-10 left-0 right-0 items-center">
        <Pressable
          onPress={() => router.back()}
          className="bg-black/70 px-6 py-3 rounded-full"
        >
          <Text className="text-white">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
