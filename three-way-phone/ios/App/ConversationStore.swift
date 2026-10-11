import Foundation

struct ProviderTurn: Sendable {
    let author: String
    let text: String
}
struct ProviderConnection: Sendable {
    let ready: Bool
    let label: String
}
@MainActor
protocol AssistantServing: AnyObject {
    var connections: [String: ProviderConnection] { get }
    var loginBusy: Bool { get }
    func startLogin(_ provider: String) async throws -> String
    func completeClaudeLogin(_ pastedCode: String) async throws
    func reply(provider: String, prompt: String, context: [ProviderTurn]) async throws -> String
}

struct Conversation: Codable {
    let id: String
    var title: String
}
struct ChatMessage: Codable {
    let id: String
    let room: String
    let author: String
    var text: String
    var status: String
    let created: Double
    let target: String
    let rounds: Int
}
private struct ChatHistory: Codable {
    var rooms: [Conversation]
    var messages: [ChatMessage]
}
struct HostReply {
    let status: Int
    let body: [String: Any]
    init(_ body: [String: Any], status: Int = 200) { self.body = body; self.status = status }
}

/// Only this phone owns chat history. A successful write reply follows the atomic disk save.
@MainActor
final class ConversationStore {
    private var history: ChatHistory
    private let file: URL
    private var loadError: String?
    private weak var providers: AssistantServing?
    private var activeReply: Task<[ChatMessage], Error>?
    private var activeReplyID: UUID?
    private(set) var changedSinceBackup = false
    private var revision = 0

    init(file: URL? = nil, providers: AssistantServing? = nil) {
        self.providers = providers
        self.file = file ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ThreeWay/conversations.json")
        history = ChatHistory(rooms: [Conversation(id: UUID().uuidString.lowercased(), title: "New conversation")], messages: [])
        if FileManager.default.fileExists(atPath: self.file.path) {
            do {
                let data = try Data(contentsOf: self.file)
                guard data.count <= 600_000 else { throw CocoaError(.fileReadTooLarge) }
                history = try JSONDecoder().decode(ChatHistory.self, from: data)
                guard !history.rooms.isEmpty, history.rooms.count <= 50, history.messages.count <= 500 else { throw CocoaError(.fileReadCorruptFile) }
            } catch { loadError = "The saved room could not be read. Its file has been preserved." }
        }
    }

    private func commit(_ next: ChatHistory) throws {
        let data = try JSONEncoder().encode(next)
        guard data.count <= 600_000 else { throw StoreFailure("This phone’s room storage is full. Export your conversations first.") }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        history = next
        changedSinceBackup = true
        revision += 1
    }
    private func snapshot(room: String) throws -> [String: Any] {
        // Persist the initial room ID before another device can address it.
        if !FileManager.default.fileExists(atPath: file.path) { try commit(history) }
        let rooms = history.rooms.map { ["id": $0.id, "title": $0.title] }
        let messages = history.messages.filter { $0.room == room }.map { message -> [String: Any] in
            ["id": message.id, "author": message.author, "text": message.text,
             "status": message.status, "created": message.created, "target": message.target]
        }
        let connections = providers?.connections ?? [
            "gpt": ProviderConnection(ready: false, label: "Not connected on this iPhone"),
            "claude": ProviderConnection(ready: false, label: "Not connected on this iPhone")]
        return ["rooms": rooms, "messages": messages, "busy": activeReply != nil,
                "login_busy": providers?.loginBusy ?? false,
                "connections": connections.mapValues { ["ready": $0.ready, "label": $0.label] }]
    }
    func handle(action: String, body: [String: Any]) -> HostReply {
        if let loadError { return HostReply(["error": loadError], status: 500) }
        do {
            switch action {
            case "state", "refresh":
                return HostReply(try snapshot(room: body["room"] as? String ?? ""))
            case "new":
                guard let id = body["request_id"] as? String, UUID(uuidString: id) != nil else { throw StoreFailure("Invalid conversation ID.") }
                if history.rooms.contains(where: { $0.id == id }) { return HostReply(["room": id]) }
                guard history.rooms.count < 50 else { throw StoreFailure("This build supports 50 conversations. Export them before creating more.") }
                var next = history
                next.rooms.insert(Conversation(id: id, title: "New conversation"), at: 0)
                try commit(next); return HostReply(["room": id])
            case "send":
                guard let id = body["request_id"] as? String, UUID(uuidString: id) != nil,
                      let room = body["room"] as? String, history.rooms.contains(where: { $0.id == room }),
                      let raw = body["text"] as? String,
                      let target = body["target"] as? String, ["both", "gpt", "claude", "discuss"].contains(target),
                      let rounds = body["rounds"] as? Int, (1...3).contains(rounds) else { throw StoreFailure("Invalid prompt. Refresh the room and retry.") }
                let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty, text.utf16.count <= 12_000 else { throw StoreFailure("Enter a prompt of 1–12,000 characters.") }
                if let existing = history.messages.first(where: { $0.id == id }) {
                    guard existing.room == room, existing.text == text, existing.target == target, existing.rounds == rounds else { throw StoreFailure("This request ID is already in use.") }
                } else {
                    guard history.messages.count < 500 else { throw StoreFailure("This build supports 500 saved prompts. Export your conversations first.") }
                    var next = history
                    next.messages.append(ChatMessage(id: id, room: room, author: "user", text: text,
                        status: "saved", created: Date().timeIntervalSince1970, target: target, rounds: rounds))
                    if let index = next.rooms.firstIndex(where: { $0.id == room }), next.rooms[index].title == "New conversation" {
                        next.rooms[index].title = String(text.prefix(45))
                    }
                    try commit(next)
                }
                return HostReply(["ok": true, "notice": "Saved on your iPhone. GPT and Claude are not connected yet."])
            case "export":
                let data = try JSONEncoder().encode(history)
                return HostReply(try JSONSerialization.jsonObject(with: data) as! [String: Any])
            case "login":
                return HostReply(["notice": "Assistant sign-in is not included in this phone connection build."])
            case "stop": return HostReply(["ok": true])
            default: return HostReply(["error": "Unknown room action."], status: 404)
            }
        } catch let error as StoreFailure { return HostReply(["error": error.text], status: 400) }
        catch { return HostReply(["error": "The phone could not save this change. Unlock it and retry."], status: 500) }
    }

    func handleAsync(action: String, body: [String: Any]) async -> HostReply {
        guard let providers else { return handle(action: action, body: body) }
        if action == "login" {
            guard let provider = body["provider"] as? String, ["gpt", "claude"].contains(provider) else {
                return HostReply(["error": "Choose ChatGPT or Claude."], status: 400)
            }
            do { return HostReply(["notice": try await providers.startLogin(provider)]) }
            catch { return HostReply(["error": error.localizedDescription], status: 400) }
        }
        if action == "stop" {
            activeReply?.cancel(); activeReply = nil; activeReplyID = nil
            return HostReply(["ok": true, "notice": "Stopped the current reply."])
        }
        guard action == "send" else { return handle(action: action, body: body) }
        if activeReply != nil { return HostReply(["error": "The assistants are already replying."], status: 400) }
        let saved = handle(action: action, body: body)
        guard saved.status == 200,
              let requestID = body["request_id"] as? String,
              let room = body["room"] as? String,
              let prompt = body["text"] as? String,
              let target = body["target"] as? String,
              let rounds = body["rounds"] as? Int else { return saved }
        if history.messages.contains(where: { $0.id.hasPrefix(requestID + ":") }) {
            return HostReply(["ok": true, "notice": "This prompt and its replies are already saved."])
        }
        let context = history.messages.filter { $0.room == room && $0.id != requestID }
            .map { ProviderTurn(author: $0.author, text: $0.text) }
        let replyID = UUID()
        let task = Task { [providers] in
            var made: [ChatMessage] = []
            let order: [String]
            if target == "discuss" { order = (0..<rounds).flatMap { _ in ["gpt", "claude"] } }
            else if target == "both" { order = ["gpt", "claude"] }
            else { order = [target] }
            var runningContext = context
            for (index, provider) in order.enumerated() {
                try Task.checkCancellation()
                let serviceName = provider == "gpt" ? "ChatGPT" : "Claude"
                let requestText = target == "discuss" && index > 0
                    ? "Continue this discussion and respond to the other assistant's latest point. Original request: \(prompt)"
                    : prompt
                let answer = try await providers.reply(provider: provider, prompt: requestText, context: runningContext)
                let message = ChatMessage(id: "\(requestID):\(provider):\(index)", room: room, author: provider,
                    text: answer, status: "complete", created: Date().timeIntervalSince1970, target: serviceName, rounds: rounds)
                made.append(message); runningContext.append(ProviderTurn(author: provider, text: answer))
            }
            return made
        }
        activeReply = task; activeReplyID = replyID
        do {
            let replies = try await task.value
            guard activeReplyID == replyID else { throw CancellationError() }
            activeReply = nil; activeReplyID = nil
            var next = history; next.messages.append(contentsOf: replies); try commit(next)
            return HostReply(["ok": true, "notice": "Assistant replies saved on your iPhone."])
        } catch is CancellationError {
            if activeReplyID == replyID { activeReply = nil; activeReplyID = nil }
            return HostReply(["error": "The reply was stopped."], status: 400)
        } catch {
            if activeReplyID != replyID {
                return HostReply(["error": "The reply was stopped."], status: 400)
            }
            if activeReplyID == replyID { activeReply = nil; activeReplyID = nil }
            var next = history
            next.messages.append(ChatMessage(id: "\(requestID):error", room: room, author: "system",
                text: error.localizedDescription, status: "error", created: Date().timeIntervalSince1970, target: target, rounds: rounds))
            try? commit(next)
            return HostReply(["error": error.localizedDescription], status: 400)
        }
    }

    func exportSnapshot() throws -> (Data, Int) { (try JSONEncoder().encode(history), revision) }
    func markBackedUp(revision saved: Int) { if saved == revision { changedSinceBackup = false } }
}
private struct StoreFailure: Error {
    let text: String
    init(_ text: String) { self.text = text }
}
