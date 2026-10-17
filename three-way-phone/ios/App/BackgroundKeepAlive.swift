import AVFoundation
import Combine
import Foundation

/// Keeps the phone-owned relay eligible to run while this sideloaded app is
/// backgrounded. The engine is silent, mixes with other audio, and is released
/// immediately when hosting stops or the app returns to the foreground.
@MainActor
final class BackgroundKeepAlive: ObservableObject {
    static let shared = BackgroundKeepAlive()

    @Published private(set) var active = false
    @Published private(set) var status = "Background hosting is ready."

    private var enabled = true
    private var hosting = false
    private var foreground = true
    private var interrupted = false
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var ownsSession = false
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
            object: nil, queue: .main) { [weak self] notification in
            let raw = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
            let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
            Task { @MainActor in self?.handleInterruption(raw: raw, options: options) }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: nil, queue: .main) { [weak self] notification in
            Task { @MainActor in
                guard let self, let changed = notification.object as? AVAudioEngine,
                      self.engine === changed else { return }
                self.tearDown()
                self.reconcile()
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.ownsSession = false
                self.tearDown()
                self.reconcile()
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification,
            object: nil, queue: .main) { [weak self] notification in
            let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue ?? 0
            Task { @MainActor in
                guard let self, self.shouldRun,
                      reason != AVAudioSession.RouteChangeReason.categoryChange.rawValue,
                      self.engine?.isRunning == false else { return }
                self.tearDown(); self.reconcile()
            }
        })
    }

    func update(enabled: Bool, hosting: Bool, foreground: Bool) {
        self.enabled = enabled
        self.hosting = hosting
        self.foreground = foreground
        if foreground || !enabled || !hosting { interrupted = false }
        reconcile()
    }

    private var shouldRun: Bool { enabled && hosting && !foreground && !interrupted }

    private func handleInterruption(raw: UInt?, options: UInt) {
        guard let raw, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            interrupted = true
            ownsSession = false
            tearDown()
        } else {
            interrupted = !AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
        }
        reconcile()
    }

    private func reconcile() {
        guard shouldRun else {
            tearDown()
            status = interrupted ? "Background audio was interrupted." : "Background hosting is ready."
            return
        }
        guard engine?.isRunning != true || player?.isPlaying != true else { return }
        tearDown()
        do {
            guard let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 11_025),
                  let samples = buffer.floatChannelData else {
                throw LinkFailure.message("Could not allocate background audio.")
            }
            buffer.frameLength = 11_025
            samples[0].initialize(repeating: 0, count: Int(buffer.frameLength))
            let nextEngine = AVAudioEngine()
            let nextPlayer = AVAudioPlayerNode()
            engine = nextEngine
            player = nextPlayer
            nextEngine.attach(nextPlayer)
            nextEngine.connect(nextPlayer, to: nextEngine.mainMixerNode, format: format)
            nextEngine.mainMixerNode.outputVolume = 0
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            ownsSession = true
            nextPlayer.scheduleBuffer(buffer, at: nil, options: [.loops], completionHandler: nil)
            try nextEngine.start()
            nextPlayer.play()
            active = true
            status = "Background hosting is active."
        } catch {
            tearDown()
            status = "Background hosting could not start: \(error.localizedDescription)"
        }
    }

    private func tearDown() {
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
        active = false
        if ownsSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsSession = false
        }
    }
}
