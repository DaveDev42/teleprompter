import SwiftUI
import AVFoundation
#if os(iOS)
import UIKit
#endif

// MARK: - Camera availability

/// Returns true only on real iOS/iPadOS hardware with a camera device.
/// On macOS (native) and iOS Simulator there is no capture device.
private func hasCameraDevice() -> Bool {
#if os(iOS)
    return AVCaptureDevice.default(for: .video) != nil
#else
    return false
#endif
}

// MARK: - AVCapture coordinator (iOS-only)

#if os(iOS)
/// UIKit/AVFoundation coordinator that drives an `AVCaptureSession` and
/// forwards the first decoded QR string to the SwiftUI layer.
///
/// Lifecycle: created by `QRScannerRepresentable.makeCoordinator()`, kept alive
/// as long as the `UIView` is in the hierarchy. On `prepare()` it asks for camera
/// permission, creates the session, and starts scanning. `tearDown()` must be
/// called from `dismantleUIView` to stop the session on a background thread.
final class QRScannerCoordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    /// Called at most once with the decoded QR payload string.
    var onDecoded: ((String) -> Void)?
    var onPermissionDenied: (() -> Void)?

    private var session: AVCaptureSession?
    private var hasDelivered = false

    func prepare(previewLayer: AVCaptureVideoPreviewLayer,
                 completion: @escaping (Error?) -> Void) {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            if granted {
                self.setupSession(previewLayer: previewLayer, completion: completion)
            } else {
                DispatchQueue.main.async { self.onPermissionDenied?() }
            }
        }
    }

    private func setupSession(previewLayer: AVCaptureVideoPreviewLayer,
                              completion: @escaping (Error?) -> Void) {
        let s = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            completion(NSError(domain: "QRScanner", code: 1,
                               userInfo: [NSLocalizedDescriptionKey: "No video device"]))
            return
        }
        let output = AVCaptureMetadataOutput()
        guard s.canAddInput(input), s.canAddOutput(output) else {
            completion(NSError(domain: "QRScanner", code: 2,
                               userInfo: [NSLocalizedDescriptionKey: "Cannot configure capture session"]))
            return
        }
        s.addInput(input)
        s.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        DispatchQueue.main.async {
            previewLayer.session = s
            previewLayer.videoGravity = .resizeAspectFill
            completion(nil)
        }
        session = s
        DispatchQueue.global(qos: .userInitiated).async { s.startRunning() }
    }

    func tearDown() {
        let s = session
        session = nil
        DispatchQueue.global(qos: .userInitiated).async { s?.stopRunning() }
    }

    // MARK: AVCaptureMetadataOutputObjectsDelegate

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !hasDelivered,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let str = obj.stringValue else { return }
        hasDelivered = true
        onDecoded?(str)
    }
}

/// `UIViewRepresentable` wrapping an `AVCaptureVideoPreviewLayer` inside a
/// `UIView`. The coordinator drives the capture session.
struct QRScannerRepresentable: UIViewRepresentable {
    var onDecoded: (String) -> Void
    var onPermissionDenied: () -> Void

    func makeCoordinator() -> QRScannerCoordinator {
        let c = QRScannerCoordinator()
        c.onDecoded = onDecoded
        c.onPermissionDenied = onPermissionDenied
        return c
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        let previewLayer = AVCaptureVideoPreviewLayer()
        // CALayer.autoresizingMask was removed in iOS 26.5; use needsDisplayOnBoundsChange
        // and resize in layoutSublayers instead. For our use case, set frame in updateUIView.
        view.layer.addSublayer(previewLayer)
        // Store the previewLayer in the view's tag-space via associated object isn't
        // needed here; we'll resize it in updateUIView. Set initial frame.
        previewLayer.frame = view.bounds

        context.coordinator.prepare(previewLayer: previewLayer) { _ in }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // Resize the preview layer to fill the view whenever bounds change.
        if let previewLayer = uiView.layer.sublayers?.first as? AVCaptureVideoPreviewLayer {
            previewLayer.frame = uiView.bounds
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: QRScannerCoordinator) {
        coordinator.tearDown()
    }
}
#endif

// MARK: - QRScannerView (cross-platform)

/// A camera-based QR scanner that decodes `tp://` pairing bundles.
///
/// Platform behavior:
/// - **iOS (real device):** Full `AVCaptureSession` live preview using
///   `AVCaptureMetadataOutput` with `.qr`. Requires `NSCameraUsageDescription`
///   in Info.plist (already set in `ios/project.yml`).
/// - **iOS Simulator / macOS:** No camera is available; shows a "camera
///   unavailable" notice and surfaces the manual-paste fallback CTA.
///
/// The decoded QR string is forwarded to `onDecoded`. The caller is responsible
/// for feeding it through `PairingStore.ingest` / `DeepLinkHandler.handle`.
struct QRScannerView: View {
    /// Called with the raw QR payload (a `tp://` URL or JSON blob).
    var onDecoded: (String) -> Void
    /// Called when the user taps "Enter code manually" or camera is unavailable.
    var onManualFallback: () -> Void
    /// Called to dismiss/cancel the scanner.
    var onCancel: () -> Void

    @State private var permissionDenied = false
    @State private var scanError: String? = nil

    private let cameraAvailable: Bool = hasCameraDevice()

    var body: some View {
        if cameraAvailable {
            cameraBody
        } else {
            unavailableBody
        }
    }

    // MARK: Camera body (iOS device only)

    @ViewBuilder
    private var cameraBody: some View {
#if os(iOS)
        ZStack {
            Color.black.ignoresSafeArea()

            if permissionDenied {
                permissionDeniedBody
            } else {
                QRScannerRepresentable(
                    onDecoded: { [self] str in
                        onDecoded(str)
                    },
                    onPermissionDenied: {
                        permissionDenied = true
                    }
                )
                .ignoresSafeArea()
                .accessibilityIdentifier("qr-camera-preview")

                viewfinderOverlay
            }
        }
        .navigationTitle("Scan QR Code")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onCancel)
            }
        }
#else
        unavailableBody
#endif
    }

    // MARK: Viewfinder overlay

    @ViewBuilder
    private var viewfinderOverlay: some View {
        VStack {
            Spacer()
            // Aim guide
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.white.opacity(0.8), lineWidth: 3)
                .frame(width: 240, height: 240)
                .overlay(
                    Text("Point at the QR code")
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.9))
                        .padding(.top, 260)
                )
            Spacer()
            if let err = scanError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("qr-scan-error")
            }
            Button("Enter code manually", action: onManualFallback)
                .font(.subheadline)
                .foregroundStyle(Color.white)
                .padding(.bottom, 32)
        }
    }

    // MARK: Permission denied

    @ViewBuilder
    private var permissionDeniedBody: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.slash")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("Camera Access Required")
                .font(.headline)
            Text("Teleprompter needs camera access to scan QR codes. Enable it in Settings.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button("Open Settings") {
                #if os(iOS)
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
                #endif
            }
            .buttonStyle(.borderedProminent)
            Button("Enter code manually", action: onManualFallback)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding()
    }

    // MARK: Camera unavailable (Simulator / macOS)

    @ViewBuilder
    private var unavailableBody: some View {
        VStack(spacing: 20) {
            Image(systemName: "camera.slash")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("qr-camera-unavailable")
            Text("Camera Not Available")
                .font(.headline)
            Text("The camera is not available on this device.\nPaste your pairing code below.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button("Enter Pairing Code Manually", action: onManualFallback)
                .buttonStyle(.borderedProminent)
            Button("Cancel", action: onCancel)
                .foregroundStyle(.secondary)
        }
        .padding()
        .navigationTitle("Scan QR Code")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onCancel)
            }
        }
    }
}
