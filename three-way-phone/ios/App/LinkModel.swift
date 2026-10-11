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
        guard version == 1, server == "https://ai.jch.workers.dev/",
              UUID(uuidString: room) != nil,
              phoneKey.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              browserKey.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw LinkFailure.message("Choose the AI Room Phone Setup file for this website.")
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
    @Published private(set) var detail = "Import your AI Room Phone Setup file to begin."
    @Published var notice = ""
    @Published var keepScreenOn = true { didSet { updateScreen() } }
    let store = ConversationStore()
    private var runner: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var foreground = true
    private var generation = UUID()
    private var lastReceived = Date.distantPast

    init() {
        if let saved = ProfileStore.read(), (try? saved.validate()) != nil {
            profile = saved; status = "Ready to connect"; detail = "Connect this iPhone to your website."
        }
    }
    func importProfile(from url: URL) throws {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0 && size <= 8192 else { throw LinkFailure.message("The setup file could not be read.") }
        let profile = try JSONDecoder().decode(LinkProfile.self, from: Data(contentsOf: url))
        try profile.validate(); try ProfileStore.write(profile)
        disconnect(); self.profile = profile; status = "Ready to connect"; detail = "Pairing saved. Tap Connect."
    }
    func connect() {
        guard profile != nil else { return }
        wantsConnection = true
        if foreground { startRunner() }
    }
    func disconnect() {
        wantsConnection = false; cancelConnection()
        status = profile == nil ? "Pair your iPhone" : "Disconnected"
        detail = "Conversations stay saved on this iPhone."
    }
    func setForeground(_ active: Bool) {
        foreground = active
        if active && wantsConnection { startRunner() }
        else if !active {
            cancelConnection()
            if wantsConnection { status = "Paused"; detail = "Reopen AI Room to reconnect your website." }
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
    private func transmit(_ body: [String: Any], socket: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: body)
        guard data.count <= 750_000 else { throw LinkFailure.message("Room response is too large.") }
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
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
                        guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let type = body["type"] as? String else { throw LinkFailure.message("Unexpected website response.") }
                        if type == "replaced" {
                            self.status = "Another phone connected"; self.detail = "Tap Connect to use this iPhone instead."
                            self.wantsConnection = false; throw LinkFailure.message("Another phone connected.")
                        }
                        if type == "hello", body["protocol"] as? String == "three-way-host/1" {
                            try await self.transmit(["type": "ready", "protocol": "three-way-host/1"], socket: socket)
                        } else if type == "connected", body["protocol"] as? String == "three-way-host/1" {
                            self.connected = true; self.status = "Connected to Cloudflare"
                            self.detail = "Your iPhone hosts the room. Your laptop can be off."
                            attempt = 0; self.updateScreen()
                        } else if type == "request", self.connected,
                                  let id = body["id"] as? String, UUID(uuidString: id) != nil,
                                  let action = body["action"] as? String,
                                  let input = body["body"] as? [String: Any] {
                            let reply = self.store.handle(action: action, body: input)
                            try await self.transmit(["type": "response", "id": id, "status": reply.status, "body": reply.body], socket: socket)
                        } else { throw LinkFailure.message("Unexpected website response.") }
                    }
                } catch {
                    if Task.isCancelled || self.generation != current { return }
                    self.connected = false; self.updateScreen()
                    if !self.wantsConnection {
                        // Preserve the replacement notice from the server.
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
    private func updateScreen() { UIApplication.shared.isIdleTimerDisabled = foreground && wantsConnection && keepScreenOn }
}
