import SwiftUI
import UniformTypeIdentifiers

@main
@MainActor
struct ThreeWayApp: App {
    @StateObject private var model = LinkModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            PhoneDashboard(model: model)
                .onChange(of: phase) { _, next in
                    if next == .active { model.setForeground(true) }
                    else if next == .background { model.setForeground(false) }
                }
        }
    }
}
private struct PhoneDashboard: View {
    @ObservedObject var model: LinkModel
    @State private var importing = false
    @State private var connections = false
    @State private var exportURL: URL?
    private var sharing: Binding<Bool> {
        Binding(get: { exportURL != nil }, set: { if !$0 { exportURL = nil } })
    }
    var body: some View {
        NavigationStack {
            DashboardView(model: model, exportURL: $exportURL)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Label(model.connected ? "Phone host connected" : "Phone room", systemImage: model.connected ? "checkmark.icloud" : "iphone")
                            .font(.caption).foregroundStyle(model.connected ? Color.green : Color.secondary)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Connections", systemImage: "link") { connections = true }
                    }
                }
                .sheet(isPresented: $connections) {
                    NavigationStack {
                        Form {
                            Section("Phone host") {
                                Text(model.status).font(.headline)
                                Text(model.detail).foregroundStyle(.secondary)
                                if model.profile != nil {
                                    Button(model.wantsConnection ? "Disconnect" : "Connect to Cloudflare") {
                                        if model.wantsConnection { model.disconnect() } else { model.connect() }
                                    }
                                }
                                Button(model.profile == nil ? "Import phone setup" : "Import updated phone setup") { connections = false; importing = true }
                                Toggle("Keep screen awake while connected", isOn: $model.keepScreenOn)
                            }
                            if let profile = model.profile {
                                Section("Your website") {
                                    ShareLink(item: profile.website) { Label("Private Website link", systemImage: "square.and.arrow.up") }
                                    Text("Open this link in another browser to use your phone’s room. Share it only with people who may read and send messages.").font(.caption)
                                }
                            }
                            Section { Text("Keep Three Way open while using the website. Your laptop can be off. Your conversations stay on this iPhone.") }
                            Section("Assistant connections") { Text("GPT and Claude are not connected in this build. Prompts save on the phone with your chosen recipients.").foregroundStyle(.secondary) }
                            if !model.notice.isEmpty { Section { Text(model.notice) } }
                        }
                        .navigationTitle("Connections")
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { connections = false } } }
                    }
                }
                .sheet(isPresented: sharing) { if let exportURL { ConversationShare(url: exportURL) } }
                .fileImporter(isPresented: $importing, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
                    do {
                        if let file = try result.get().first { try model.importProfile(from: file); model.connect() }
                    } catch { model.notice = "Could not import setup. Choose the Three Way Phone Setup JSON file." }
                    connections = true
                }
        }
    }
}
