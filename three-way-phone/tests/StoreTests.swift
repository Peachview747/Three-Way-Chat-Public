import Foundation

@main
struct StoreTests {
    @MainActor static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("history.json")
        let store = ConversationStore(file: file)
        let first = store.handle(action: "state", body: [:])
        precondition(first.status == 200)
        let rooms = first.body["rooms"] as! [[String: String]]
        let room = rooms[0]["id"]!
        let id = UUID().uuidString.lowercased()
        let prompt: [String: Any] = ["request_id": id, "room": room, "text": "Hello 🌎 </script>", "target": "both", "rounds": 2]
        precondition(store.handle(action: "send", body: prompt).status == 200)
        precondition(store.handle(action: "send", body: prompt).status == 200)
        var changed = prompt; changed["text"] = "Changed"
        precondition(store.handle(action: "send", body: changed).status == 400)
        var invalid = prompt; invalid["request_id"] = "invalid"
        precondition(store.handle(action: "send", body: invalid).status == 400)
        invalid = prompt; invalid["text"] = String(repeating: "🌎", count: 6001)
        precondition(store.handle(action: "send", body: invalid).status == 400)
        let reloaded = ConversationStore(file: file)
        let state = reloaded.handle(action: "state", body: ["room": room])
        let messages = state.body["messages"] as! [[String: Any]]
        precondition(messages.count == 1 && messages[0]["text"] as? String == "Hello 🌎 </script>")
        let connections = state.body["connections"] as! [String: [String: Any]]
        precondition(connections["gpt"]!["ready"] as? Bool == false)
        let newID = UUID().uuidString.lowercased()
        precondition(reloaded.handle(action: "new", body: ["request_id": newID]).body["room"] as? String == newID)
        precondition(reloaded.handle(action: "new", body: ["request_id": newID]).status == 200)
        let all = reloaded.handle(action: "export", body: [:]).body["rooms"] as! [[String: Any]]
        precondition(all.count == 2)
        // An unreadable store must not be replaced by an empty one.
        let broken = directory.appendingPathComponent("broken.json")
        let bytes = Data("broken history".utf8); try bytes.write(to: broken)
        precondition(ConversationStore(file: broken).handle(action: "state", body: [:]).status == 500)
        let preserved = try Data(contentsOf: broken)
        precondition(preserved == bytes)
        // Disk failures do not acknowledge or mutate the in-memory conversation.
        let blocked = directory.appendingPathComponent("blocked")
        try Data().write(to: blocked)
        let failed = ConversationStore(file: blocked.appendingPathComponent("history.json"))
        precondition(failed.handle(action: "state", body: [:]).status == 500)
        print("PASS: phone history persists, retries deduplicate, invalid writes fail, providers stay disconnected, and damaged files are preserved.")
    }
}
