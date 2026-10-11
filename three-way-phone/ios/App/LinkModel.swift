import Foundation
import Security
import UIKit

struct LinkProfile: Codable {
    let version: Int
    let server: String
    let room: String
    let phoneKey: String
    let browserKey: String

    func validate() throws {
        guard version == 1, server == "https://three-way-chat.jcruzhoovertesla.workers.dev/",
              UUID(uuidString: room) != nil,
              phoneKey.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              browserKey.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw LinkFailure.message("Choose the Three Way Phone Setup file for this website.")
        }
    }
    var website: URL {
        var url = URLComponents(string: server)!
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name: "room", value: room), URLQueryItem(name: "key", value: browserKey)]
        url.percentEncodedFragment = fragment.percentEncodedQuery
        return url.url!
    }
}

struct LinkMessage: Codable, Identifiable, Equatable {
    let id: String
    let source: String
    let text: String
    let created: String
    var title: String { source == "iphone" ? "Your iPhone" : "Your browser" }
}

struct LinkState: Decodable {
    let type: String
    let `protocol`: String?
    let connected: Bool?
    let messages: [LinkMessage]?
    let error: String?
}

struct PendingMessage: Codable { let id: String; let text: String }
private struct LocalHistory: Codable { let messages: [LinkMessage]; let pending: PendingMessage? }
enum LinkFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

private enum ProfileStore {
    static let service = "com.peachview.threeway.phone"
    static func read() -> LinkProfile? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "link-profile",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(LinkProfile.self, from: data)
    }
    static func write(_ profile: LinkProfile) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "link-profile"]
        let values: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(profile),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query; values.forEach { insert[$0.key] = $0.value }
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw LinkFailure.message("Could not save the pairing. Unlock the phone and retry.") }
        } else if status != errSecSuccess { throw LinkFailure.message("Could not save the pairing. Unlock the phone and retry.") }
    }
}

@MainActor
final class LinkModel: ObservableObject {
    @Published private(set) var profile: LinkProfile?
    @Published private(set) var connected = false
    @Published private(set) var wantsConnection = false
    @Published private(set) var status = "Pair your iPhone"
    @Published private(set) var detail = "Import your Three Way Phone Setup file to begin."
    @Published private(set) var messages: [LinkMessage] = []
    @Published private(set) var pending: PendingMessage?
    @Published var draft = ""
    @Published var notice = ""
    @Published var keepScreenOn = true { didSet { updateScreen() } }
    private var runner: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var foreground = true
    private var generation = UUID()
    private var lastReceived = Date.distantPast
    private static var historyURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ThreeWay/link-history.json")
    }

    init() {
        if let saved = ProfileStore.read(), (try? saved.validate()) != nil {
            profile = saved; status = "Ready to connect"; detail = "Tap Connect to link this iPhone to your website."
        }
        if let data = try? Data(contentsOf: Self.historyURL), let history = try? JSONDecoder().decode(LocalHistory.self, from: data) {
            messages = Array(history.messages.suffix(100)); pending = history.pending
            if let pending { draft = pending.text }
        }
    }

    func importProfile(from url: URL) throws {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0 && size <= 8192 else { throw LinkFailure.message("The setup file could not be read.") }
        let profile = try JSONDecoder().decode(LinkProfile.self, from: Data(contentsOf: url))
        try profile.validate(); try ProfileStore.write(profile)
        disconnect()
        if self.profile?.room != profile.room { messages = []; pending = nil; draft = ""; saveHistory() }
        self.profile = profile; status = "Ready to connect"; detail = "Pairing saved. Tap Connect."
    }

    func connect() {
        guard profile != nil else { return }
        wantsConnection = true
        if foreground { startRunner() }
    }
    func disconnect() {
        wantsConnection = false; cancelConnection()
        status = profile == nil ? "Pair your iPhone" : "Disconnected"
        detail = "Tap Connect when you want to use the website."
    }
    func setForeground(_ active: Bool) {
        foreground = active
        if active && wantsConnection { startRunner() }
        else if !active {
            cancelConnection()
            if wantsConnection { status = "Paused"; detail = "Reopen Three Way to reconnect your website." }
        }
        updateScreen()
    }
    private func cancelConnection() {
        generation = UUID(); runner?.cancel(); runner = nil
        heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        session?.invalidateAndCancel(); session = nil
        connected = false; updateScreen()
    }
    private func startRunner() {
        guard runner == nil, let profile else { return }
        let current = UUID(); generation = current
        runner = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled && self.wantsConnection && self.foreground && self.generation == current {
                self.status = attempt == 0 ? "Connecting…" : "Reconnecting…"
                self.detail = "Reaching your Cloudflare website."
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForRequest = 15
                configuration.timeoutIntervalForResource = 24 * 60 * 60
                configuration.httpShouldSetCookies = false; configuration.urlCache = nil
                let session = URLSession(configuration: configuration); self.session = session
                var components = URLComponents(string: profile.server + "api/phone")!
                components.scheme = "wss"
                var request = URLRequest(url: components.url!)
                request.setValue("Bearer " + profile.phoneKey, forHTTPHeaderField: "Authorization")
                let socket = session.webSocketTask(with: request)
                socket.maximumMessageSize = 1_000_000
                self.socket = socket; socket.resume()
                self.heartbeat = Task { [weak self] in
                    do {
                        try await Task.sleep(nanoseconds: 12_000_000_000)
                        guard let self, self.generation == current, self.socket === socket else { return }
                        if !self.connected { socket.cancel(with: .goingAway, reason: nil); return }
                        while !Task.isCancelled {
                            if Date().timeIntervalSince(self.lastReceived) > 45 {
                                socket.cancel(with: .goingAway, reason: nil); return
                            }
                            try await socket.send(.string("ping"))
                            try await Task.sleep(nanoseconds: 20_000_000_000)
                            guard self.generation == current, self.socket === socket else { return }
                        }
                    } catch { if !Task.isCancelled { socket.cancel(with: .goingAway, reason: nil) } }
                }
                do {
                    var sentPending = false
                    while !Task.isCancelled {
                        let received = try await socket.receive()
                        guard self.generation == current, self.socket === socket else { return }
                        self.lastReceived = Date()
                        let data: Data
                        switch received {
                        case .string(let text):
                            if text == "pong" { continue }
                            data = Data(text.utf8)
                        case .data(let bytes): data = bytes
                        @unknown default: continue
                        }
                        let state = try JSONDecoder().decode(LinkState.self, from: data)
                        if state.type == "replaced" {
                            self.status = "Another phone connected"; self.detail = "Tap Connect to use this iPhone instead."
                            self.wantsConnection = false
                            throw LinkFailure.message("Another phone connected.")
                        }
                        if state.type == "error" {
                            self.notice = state.error ?? "The message was not accepted."
                            continue
                        }
                        guard state.type == "state", state.protocol == "three-way-link/1", state.connected == true,
                              let messages = state.messages, messages.count <= 100 else {
                            throw LinkFailure.message("The website returned an unexpected response.")
                        }
                        self.connected = true; self.status = "Connected to Cloudflare"
                        self.detail = "Your iPhone and website share the messages below."
                        self.messages = messages; attempt = 0; self.updateScreen()
                        if let pending = self.pending, messages.contains(where: { $0.id == pending.id && $0.source == "iphone" && $0.text == pending.text }) {
                            if self.draft == pending.text { self.draft = "" }
                            self.pending = nil; self.notice = "Message confirmed by Cloudflare."
                        }
                        self.saveHistory()
                        if !sentPending, let pending = self.pending {
                            sentPending = true
                            try await self.transmit(pending, socket: socket)
                        }
                    }
                } catch {
                    if Task.isCancelled || self.generation != current { return }
                    self.connected = false; self.updateScreen()
                    if !self.wantsConnection {
                        // Preserve an explicit replacement notice from the server.
                    } else if (socket.response as? HTTPURLResponse)?.statusCode == 401 {
                        self.status = "Pairing needs updating"; self.detail = "Import your latest setup file."
                        self.wantsConnection = false
                    } else if socket.closeCode.rawValue == 4001 {
                        self.status = "Another phone connected"; self.detail = "Tap Connect to use this iPhone instead."
                        self.wantsConnection = false
                    } else { self.detail = "Connection interrupted. Retrying shortly…" }
                }
                self.heartbeat?.cancel(); self.heartbeat = nil
                socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel()
                self.socket = nil; self.session = nil
                guard self.wantsConnection else { break }
                attempt += 1
                do { try await Task.sleep(nanoseconds: UInt64(min(30, 1 << min(attempt, 5))) * 1_000_000_000) }
                catch { return }
            }
            if self.generation == current { self.runner = nil }
        }
    }
    func send() async {
        guard connected, let socket else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 2000 else { notice = "Enter a message of 1–2,000 characters."; return }
        if pending == nil || pending?.text != text { pending = PendingMessage(id: UUID().uuidString.lowercased(), text: text) }
        guard let pending else { return }
        saveHistory(); notice = "Waiting for confirmation…"
        do { try await transmit(pending, socket: socket) }
        catch { notice = "The message is saved on this phone. Reconnect and retry." }
    }
    private func transmit(_ message: PendingMessage, socket: URLSessionWebSocketTask) async throws {
        let body = ["type": "message", "id": message.id, "text": message.text]
        let data = try JSONEncoder().encode(body)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }
    private func saveHistory() {
        do {
            try FileManager.default.createDirectory(at: Self.historyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(LocalHistory(messages: messages, pending: pending)).write(to: Self.historyURL, options: [.atomic, .completeFileProtection])
        } catch { notice = "Messages are connected, but the phone could not save its local copy." }
    }
    private func updateScreen() { UIApplication.shared.isIdleTimerDisabled = foreground && wantsConnection && keepScreenOn }
}
