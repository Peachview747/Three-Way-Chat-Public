import SwiftUI
import UniformTypeIdentifiers
import UIKit

@main
@MainActor
struct ThreeWayApp: App {
    @StateObject private var model = LinkModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ConnectorView(model: model)
                .onChange(of: phase) { _, next in
                    model.setForeground(next == .active)
                }
        }
    }
}

private struct ConnectorView: View {
    @ObservedObject var model: LinkModel
    @ObservedObject private var background = BackgroundKeepAlive.shared
    @ObservedObject private var providers = ProviderManager.shared
    @State private var importing = false
    @State private var showingSetupHelp = false
    @State private var claudeCode = ""
    private let green = Color(red: 0.18, green: 0.42, blue: 0.34)

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("PHONE CONNECTOR", systemImage: "iphone.radiowaves.left.and.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(green)
                        Text("Your chat lives on the website.")
                            .font(.title2.weight(.semibold))
                        Text("This app connects your iPhone to AI Room. Use the dashboard in your browser.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }

                Section("Set up your phone and browser") {
                    Text(model.profile == nil
                         ? "First, save your private AI-Room-Phone-Setup.json file in the Files app on this iPhone."
                         : "Your phone setup is saved. Connect, then share the private website link with your other device.")
                    Button("How to set up and pair a browser", systemImage: "questionmark.circle") {
                        showingSetupHelp = true
                    }
                    .accessibilityIdentifier("setup-help")
                }

                Section("Connection") {
                    Label(model.status, systemImage: model.connected ? "checkmark.icloud.fill" : "link")
                        .font(.headline)
                        .foregroundStyle(model.connected ? green : Color.primary)
                        .accessibilityIdentifier("connection-status")
                    Text(model.detail).foregroundStyle(.secondary)
                    Button(model.wantsConnection ? "Disconnect" : "Connect to Cloudflare") {
                        if model.wantsConnection { model.disconnect() }
                        else { model.connect() }
                    }
                    .disabled(model.profile == nil)
                    .accessibilityIdentifier("connection-button")
                    Button(model.profile == nil ? "Import phone setup" : "Import updated phone setup",
                           systemImage: "square.and.arrow.down") {
                        importing = true
                    }
                    .accessibilityIdentifier("import-setup")
                    Toggle("Keep screen awake while connected", isOn: $model.keepScreenOn)
                }

                Section {
                    Text("ai.jch76.workers.dev")
                        .font(.subheadline)
                        .textSelection(.enabled)
                    if let profile = model.profile {
                        ShareLink(item: profile.website) {
                            Label("Share private website link", systemImage: "square.and.arrow.up")
                        }
                        Button("Copy private website link", systemImage: "doc.on.doc") {
                            UIPasteboard.general.url = profile.website
                            model.notice = "Private website link copied. Open it in a browser on another device."
                        }
                        DisclosureGroup("Pair a browser with codes instead") {
                            Text("Use these only if you cannot open the private website link on your other device. Enter them in the website’s ‘Open your phone’s room’ dialog.")
                                .font(.footnote)
                            Text("Room code").font(.caption)
                            Text(profile.room).textSelection(.enabled)
                            Button("Copy room code") {
                                UIPasteboard.general.string = profile.room
                                model.notice = "Room code copied."
                            }
                            Text("Browser pairing code").font(.caption)
                            Text("Copy this private code and paste it into the browser pairing field. Only share it with people who may access your room.")
                                .font(.footnote)
                            Button("Copy browser pairing code") {
                                UIPasteboard.general.string = profile.browserKey
                                model.notice = "Browser pairing code copied. Keep it private."
                            }
                        }
                    } else {
                        Text("Import your phone setup to get the private link for your room.")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Chat website")
                } footer: {
                    Text("The public address shows the dashboard. Your private link grants access to this phone’s room; share it only with people who may read and send messages.")
                }

                Section("While using the website") {
                    Text("Use the private website link on another device; your laptop can be off.")
                    Toggle("Keep hosting when app is in background", isOn: $model.keepHostingInBackground)
                    Text(background.status)
                        .foregroundStyle(.secondary)
                    Text("iOS can still interrupt background audio for calls, system pressure, or a forced app quit. AI Room reconnects automatically when reopened.")
                        .foregroundStyle(.secondary)
                }

                Section("Assistant connections") {
                    providerRow(name: "ChatGPT", status: providers.gptStatus, ready: providers.connections["gpt"]?.ready == true) {
                        beginLogin("gpt")
                    }
                    providerRow(name: "Claude", status: providers.claudeStatus, ready: providers.connections["claude"]?.ready == true) {
                        beginLogin("claude")
                    }
                    if providers.claudeNeedsCode {
                        TextField("Paste Claude authorization code", text: $claudeCode)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("claude-code")
                        Button("Finish Claude sign-in") {
                            Task {
                                do { try await providers.completeClaudeLogin(claudeCode); claudeCode = ""; model.notice = "Claude connected." }
                                catch { model.notice = error.localizedDescription }
                            }
                        }.disabled(claudeCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    Text("Service logins are saved in this iPhone’s Keychain. They are never sent to the website or GitHub backup.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if !providers.loginNote.isEmpty { Text(providers.loginNote).font(.footnote).textSelection(.enabled) }
                }

                if !model.notice.isEmpty {
                    Section { Text(model.notice).accessibilityIdentifier("connector-notice") }
                }
            }
            .navigationTitle("AI Room Connector")
            .tint(green)
            .sheet(isPresented: $showingSetupHelp) {
                NavigationStack {
                    List {
                        Section("1. Get your private setup file") {
                            Text("The person who manages your AI Room website must provide AI-Room-Phone-Setup.json for https://ai.jch76.workers.dev/. Save it to Files on this iPhone.")
                            Text("If you manage the website, the file must match your deployed room and pairing credentials. Installing the app or creating a GitHub repository does not create this file. Do not put it in the public repository.")
                        }
                        Section("2. Import and connect") {
                            Text("Return to the connector, tap Import phone setup, and choose the JSON file in Files. The app connects automatically. Wait for Connected to Cloudflare. If setup is already saved, tap Connect to Cloudflare.")
                        }
                        Section("3. Open your room on another device") {
                            Text("Under Chat website, tap Share private website link or Copy private website link. Open that exact link in your other device’s browser. It pairs the browser automatically; the public website address alone does not pair it.")
                        }
                        Section("If the website asks for codes") {
                            Text("Under Chat website, expand Pair a browser with codes instead. Copy the room code into Room code and the browser pairing code into Browser pairing code, then select Pair this browser. Do not use the phone’s connection key.")
                        }
                        Section("If you cannot connect") {
                            Text("No setup file: ask your website manager for it. An old-site setup file: request an updated file for ai.jch76.workers.dev. Phone offline: keep this connector open and check its connection status. Your conversations stay on this iPhone.")
                        }
                    }
                    .navigationTitle("Setup and browser pairing")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingSetupHelp = false }
                        }
                    }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
                switch result {
                case .success(let files):
                    do {
                        if let file = files.first {
                            try model.importProfile(from: file)
                            model.notice = "Phone setup saved. Your private website link is ready."
                            model.connect()
                        }
                    } catch {
                        model.notice = "Could not import setup. Choose the AI Room Phone Setup JSON file."
                    }
                case .failure(let error):
                    if (error as NSError).code != NSUserCancelledError {
                        model.notice = "Could not import setup. Choose the AI Room Phone Setup JSON file."
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func providerRow(name: String, status: String, ready: Bool, action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack { Text(name).font(.headline); Spacer(); Image(systemName: ready ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(ready ? green : .secondary) }
            Text(status).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
            Button(ready ? "Reconnect \(name)" : "Connect \(name)", action: action)
                .disabled(providers.loginBusy)
        }.padding(.vertical, 4)
    }

    private func beginLogin(_ provider: String) {
        Task {
            do { model.notice = try await providers.startLogin(provider) }
            catch { model.notice = error.localizedDescription }
        }
    }
}
