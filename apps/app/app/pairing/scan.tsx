import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { usePairingStore } from "../../src/stores/pairing-store";

// Dynamic import for camera (native only)
let CameraView: any = null;
let useCameraPermissions: any = null;

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
  const { processScan } = usePairingStore();
  const [scanned, setScanned] = useState(false);

  // Camera permissions (native only)
  const [permission, requestPermission] = useCameraPermissions?.() ?? [
    null,
    () => {},
  ];

  useEffect(() => {
    if (permission && !permission.granted) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);

    await processScan(data);
    if (usePairingStore.getState().state === "paired") {
      router.replace("/");
    } else {
      setScanned(false); // Allow retry
    }
  };

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
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      />
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
