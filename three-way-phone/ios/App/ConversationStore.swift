import Foundation

struct Conversation: Codable {
    let id: String
    var title: String
}
struct ChatMessage: Codable {
    let id: String
    let room: String
    let author: String
    let text: String
    let status: String
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

    init(file: URL? = nil) {
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
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        history = next
    }
    private func snapshot(room: String) throws -> [String: Any] {
        // Persist the initial room ID before another device can address it.
        if !FileManager.default.fileExists(atPath: file.path) { try commit(history) }
        let rooms = history.rooms.map { ["id": $0.id, "title": $0.title] }
        let messages = history.messages.filter { $0.room == room }.map { message -> [String: Any] in
            ["id": message.id, "author": message.author, "text": message.text,
             "status": message.status, "created": message.created, "target": message.target]
        }
        return ["rooms": rooms, "messages": messages, "busy": false, "login_busy": false,
                "connections": ["gpt": ["ready": false, "label": "Not connected on this iPhone"],
                                "claude": ["ready": false, "label": "Not connected on this iPhone"]]]
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
}
private struct StoreFailure: Error {
    let text: String
    init(_ text: String) { self.text = text }
}
