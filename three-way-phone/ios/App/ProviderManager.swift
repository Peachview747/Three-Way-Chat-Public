import AuthenticationServices
import Combine
import CryptoKit
import Foundation
import Security
import UIKit

private struct OAuthCredential: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Double
    var accountID: String?
}

private enum CredentialStore {
    static let service = "com.peachview.ai-room.providers"

    static func read(_ account: String) -> OAuthCredential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(OAuthCredential.self, from: data)
    }

    static func write(_ credential: OAuthCredential, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        let values: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(credential),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query; values.forEach { insert[$0.key] = $0.value }
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw ProviderFailure("The login could not be saved in Keychain.") }
        } else if status != errSecSuccess { throw ProviderFailure("The login could not be saved in Keychain.") }
    }
}

private struct ProviderFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

@MainActor
final class ProviderManager: ObservableObject, AssistantServing {
    static let shared = ProviderManager()
    @Published private(set) var gptStatus = "Not connected on this iPhone"
    @Published private(set) var claudeStatus = "Not connected on this iPhone"
    @Published private(set) var loginBusy = false
    @Published private(set) var claudeNeedsCode = false
    @Published private(set) var loginNote = ""

    private let codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
    private let claudeClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    private let claudeScope = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"
    private var loginTask: Task<Void, Never>?
    private var claudeVerifier: String?
    private var claudeState: String?

    private init() {
        if CredentialStore.read("gpt") != nil { gptStatus = "Connected with ChatGPT" }
        if CredentialStore.read("claude") != nil { claudeStatus = "Connected with Claude" }
    }

    var connections: [String: ProviderConnection] {
        ["gpt": ProviderConnection(ready: CredentialStore.read("gpt") != nil, label: gptStatus),
         "claude": ProviderConnection(ready: CredentialStore.read("claude") != nil, label: claudeStatus)]
    }

    func startLogin(_ provider: String) async throws -> String {
        guard !loginBusy else { throw ProviderFailure("Finish the current service login first.") }
        switch provider {
        case "gpt":
            loginBusy = true; gptStatus = "Waiting for ChatGPT authorization…"
            loginTask = Task { [weak self] in
                do { try await self?.runCodexLogin() }
                catch is CancellationError { }
                catch { self?.gptStatus = error.localizedDescription; self?.loginNote = error.localizedDescription }
                self?.loginBusy = false
            }
            return "ChatGPT sign-in opened on this iPhone. Enter the displayed code if the page asks for it."
        case "claude":
            let verifier = randomURLSafe(48), state = randomURLSafe(32)
            claudeVerifier = verifier; claudeState = state; claudeNeedsCode = true; loginBusy = true
            claudeStatus = "Paste the Claude authorization code below"
            var parts = URLComponents(string: "https://claude.com/cai/oauth/authorize")!
            parts.queryItems = [
                URLQueryItem(name: "code", value: "true"), URLQueryItem(name: "client_id", value: claudeClientID),
                URLQueryItem(name: "response_type", value: "code"),
                URLQueryItem(name: "redirect_uri", value: "https://platform.claude.com/oauth/code/callback"),
                URLQueryItem(name: "scope", value: claudeScope), URLQueryItem(name: "code_challenge", value: pkce(verifier)),
                URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "state", value: state)
            ]
            guard let url = parts.url else { throw ProviderFailure("Could not create the Claude login link.") }
            await UIApplication.shared.open(url)
            return "Claude sign-in opened on this iPhone. Copy its authorization code, return to AI Room, and paste it below."
        default: throw ProviderFailure("Unknown assistant service.")
        }
    }

    func completeClaudeLogin(_ pastedCode: String) async throws {
        guard let verifier = claudeVerifier, let expectedState = claudeState else { throw ProviderFailure("Start Claude sign-in first.") }
        let pieces = pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "#", maxSplits: 1).map(String.init)
        guard pieces.count == 2, pieces[1] == expectedState else { throw ProviderFailure("That Claude authorization code did not match this login. Start again.") }
        do {
            let result = try await postJSON(url: URL(string: "https://platform.claude.com/v1/oauth/token")!, body: [
                "grant_type": "authorization_code", "code": pieces[0],
                "redirect_uri": "https://platform.claude.com/oauth/code/callback", "client_id": claudeClientID,
                "code_verifier": verifier, "state": expectedState
            ])
            try saveToken(result, provider: "claude")
            claudeStatus = "Connected with Claude"; loginNote = "Claude connected."
            claudeNeedsCode = false; loginBusy = false; claudeVerifier = nil; claudeState = nil
        } catch {
            claudeStatus = error.localizedDescription
            throw error
        }
    }

    private func runCodexLogin() async throws {
        let start = try await postJSON(url: URL(string: "https://auth.openai.com/api/accounts/deviceauth/usercode")!, body: ["client_id": codexClientID])
        guard let device = start["device_auth_id"] as? String, let code = start["user_code"] as? String else { throw ProviderFailure("ChatGPT did not return a device code.") }
        let interval = Int(start["interval"] as? String ?? "") ?? start["interval"] as? Int ?? 5
        gptStatus = "ChatGPT code: \(code)"; loginNote = "ChatGPT code: \(code)"
        await UIApplication.shared.open(URL(string: "https://auth.openai.com/codex/device")!)
        var authorization: [String: Any]?
        for _ in 0..<120 {
            try Task.checkCancellation(); try await Task.sleep(for: .seconds(max(2, interval)))
            do {
                authorization = try await postJSON(url: URL(string: "https://auth.openai.com/api/accounts/deviceauth/token")!, body: ["device_auth_id": device, "user_code": code])
                if authorization != nil { break }
            } catch let failure as ProviderFailure where failure.message.hasPrefix("PENDING:") { continue }
        }
        guard let authorization, let authCode = authorization["authorization_code"] as? String,
              let verifier = authorization["code_verifier"] as? String else { throw ProviderFailure("ChatGPT sign-in timed out. Try Connect again.") }
        let body = form(["grant_type": "authorization_code", "client_id": codexClientID, "code": authCode,
                         "redirect_uri": "https://auth.openai.com/deviceauth/callback", "code_verifier": verifier])
        let result = try await requestJSON(URLRequest.post(URL(string: "https://auth.openai.com/oauth/token")!, body: body, type: "application/x-www-form-urlencoded"))
        try saveToken(result, provider: "gpt")
        gptStatus = "Connected with ChatGPT"; loginNote = "ChatGPT connected."
    }

    func reply(provider: String, prompt: String, context: [ProviderTurn]) async throws -> String {
        var credential = try await validCredential(provider)
        do { return try await send(provider: provider, prompt: prompt, context: context, credential: credential) }
        catch let failure as ProviderFailure where failure.message == "AUTH" {
            credential = try await refresh(provider, credential)
            return try await send(provider: provider, prompt: prompt, context: context, credential: credential)
        }
    }

    private func send(provider: String, prompt: String, context: [ProviderTurn], credential: OAuthCredential) async throws -> String {
        if provider == "claude" {
            let messages = context.suffix(30).compactMap { turn -> [String: Any]? in
                guard turn.author == "user" || turn.author == "claude" else { return nil }
                return ["role": turn.author == "user" ? "user" : "assistant", "content": turn.text]
            } + [["role": "user", "content": prompt]]
            var request = URLRequest.post(URL(string: "https://api.anthropic.com/v1/messages")!, body: try JSONSerialization.data(withJSONObject: ["model":"claude-sonnet-4-6", "max_tokens":4096, "messages":messages]), type: "application/json")
            request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
            let result = try await requestJSON(request)
            let blocks = result["content"] as? [[String: Any]] ?? []
            let text = blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            guard !text.isEmpty else { throw ProviderFailure("Claude returned an empty reply.") }; return text
        }
        let input = context.suffix(30).compactMap { turn -> [String: Any]? in
            guard ["user", "gpt"].contains(turn.author) else { return nil }
            return ["role": turn.author == "user" ? "user" : "assistant", "content": [["type": turn.author == "user" ? "input_text" : "output_text", "text": turn.text]]]
        } + [["role": "user", "content": [["type":"input_text", "text":prompt]]]]
        let payload: [String: Any] = ["model":"gpt-5.4", "stream":true, "input":input, "tools":[], "tool_choice":"auto", "parallel_tool_calls":false, "store":false, "include":[]]
        var request = URLRequest.post(URL(string: "https://chatgpt.com/backend-api/codex/responses")!, body: try JSONSerialization.data(withJSONObject: payload), type: "application/json")
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        if let account = credential.accountID { request.setValue(account, forHTTPHeaderField: "ChatGPT-Account-ID") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ProviderFailure("ChatGPT could not be reached.") }
        if http.statusCode == 401 { throw ProviderFailure("AUTH") }
        guard (200..<300).contains(http.statusCode) else { throw apiFailure(data, service: "ChatGPT", status: http.statusCode) }
        var answer = ""
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") where line.hasPrefix("data: ") {
            let raw = line.dropFirst(6); guard raw != "[DONE]", let event = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { continue }
            if event["type"] as? String == "response.output_text.delta", let delta = event["delta"] as? String { answer += delta }
        }
        guard !answer.isEmpty else { throw ProviderFailure("ChatGPT returned an empty reply.") }; return answer
    }

    private func validCredential(_ provider: String) async throws -> OAuthCredential {
        guard let saved = CredentialStore.read(provider) else { throw ProviderFailure("Connect \(provider == "gpt" ? "ChatGPT" : "Claude") on this iPhone first.") }
        if saved.expiresAt > Date().timeIntervalSince1970 + 60 { return saved }
        return try await refresh(provider, saved)
    }

    private func refresh(_ provider: String, _ saved: OAuthCredential) async throws -> OAuthCredential {
        let result: [String: Any]
        if provider == "gpt" {
            result = try await postJSON(url: URL(string: "https://auth.openai.com/oauth/token")!, body: ["grant_type":"refresh_token", "client_id":codexClientID, "refresh_token":saved.refreshToken])
        } else {
            result = try await postJSON(url: URL(string: "https://platform.claude.com/v1/oauth/token")!, body: ["grant_type":"refresh_token", "refresh_token":saved.refreshToken, "client_id":claudeClientID, "scope":claudeScope])
        }
        try saveToken(result, provider: provider, oldRefresh: saved.refreshToken, oldAccount: saved.accountID)
        guard let updated = CredentialStore.read(provider) else { throw ProviderFailure("Reconnect this assistant service.") }
        return updated
    }

    private func saveToken(_ json: [String: Any], provider: String, oldRefresh: String = "", oldAccount: String? = nil) throws {
        guard let access = json["access_token"] as? String else { throw ProviderFailure("The service did not return a login token.") }
        let refresh = json["refresh_token"] as? String ?? oldRefresh
        guard !refresh.isEmpty else { throw ProviderFailure("The service did not return a renewable login.") }
        let expires = (json["expires_in"] as? Double) ?? Double(json["expires_in"] as? Int ?? 3600)
        let identity = json["id_token"] as? String ?? access
        let account = provider == "gpt" ? (jwtClaim(identity, "chatgpt_account_id") ?? oldAccount) : nil
        try CredentialStore.write(OAuthCredential(accessToken: access, refreshToken: refresh,
            expiresAt: Date().timeIntervalSince1970 + expires, accountID: account), account: provider)
    }

    private func postJSON(url: URL, body: [String: Any]) async throws -> [String: Any] {
        try await requestJSON(URLRequest.post(url, body: try JSONSerialization.data(withJSONObject: body), type: "application/json"))
    }
    private func requestJSON(_ request: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ProviderFailure("The login service could not be reached.") }
        if [403,404].contains(http.statusCode), request.url?.path.contains("deviceauth/token") == true { throw ProviderFailure("PENDING:\(http.statusCode)") }
        if http.statusCode == 401 { throw ProviderFailure("AUTH") }
        guard (200..<300).contains(http.statusCode) else { throw apiFailure(data, service: "Service", status: http.statusCode) }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ProviderFailure("The service returned an invalid response.") }
        return object
    }
}

private extension URLRequest {
    static func post(_ url: URL, body: Data, type: String) -> URLRequest {
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = body
        request.setValue(type, forHTTPHeaderField: "Content-Type"); request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
}

private func randomURLSafe(_ count: Int) -> String {
    var bytes = [UInt8](repeating: 0, count: count); _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
private func pkce(_ verifier: String) -> String {
    Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
private func form(_ values: [String: String]) -> Data {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
    return Data(values.map { key, value in "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&").utf8)
}
private func jwtClaim(_ token: String, _ name: String) -> String? {
    let parts = token.split(separator: "."); guard parts.count > 1 else { return nil }
    var raw = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    raw += String(repeating: "=", count: (4 - raw.count % 4) % 4)
    guard let data = Data(base64Encoded: raw), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    if let direct = body[name] as? String { return direct }
    return (body["https://api.openai.com/auth"] as? [String: Any])?[name] as? String
}
private func apiFailure(_ data: Data, service: String, status: Int) -> ProviderFailure {
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    let nested = object?["error"] as? [String: Any]
    let message = nested?["message"] as? String ?? object?["error"] as? String
    return ProviderFailure(message ?? "\(service) returned error \(status).")
}
