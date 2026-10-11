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
                    if next == .active { model.setForeground(true) }
                    else if next == .background { model.setForeground(false) }
                }
        }
    }
}

private struct ConnectorView: View {
    @ObservedObject var model: LinkModel
    @State private var importing = false
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
                        Text("This app connects your iPhone to Three Way. Use the dashboard in your browser.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
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
                    Text("ai.jch.workers.dev")
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
                    Text("Keep Three Way open on this iPhone. Use the private website link on another device; your laptop can be off.")
                    Text("Locking the phone or switching apps pauses this connector. Reopen Three Way to reconnect. Conversations stay saved on this iPhone.")
                        .foregroundStyle(.secondary)
                }

                Section("Assistant connections") {
                    Text("GPT and Claude are not connected in this build. The website saves prompts on your phone; it does not produce assistant replies yet.")
                        .foregroundStyle(.secondary)
                }

                if !model.notice.isEmpty {
                    Section { Text(model.notice).accessibilityIdentifier("connector-notice") }
                }
            }
            .navigationTitle("Three Way Connector")
            .tint(green)
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
                        model.notice = "Could not import setup. Choose the Three Way Phone Setup JSON file."
                    }
                case .failure(let error):
                    if (error as NSError).code != NSUserCancelledError {
                        model.notice = "Could not import setup. Choose the Three Way Phone Setup JSON file."
                    }
                }
            }
        }
    }
}
