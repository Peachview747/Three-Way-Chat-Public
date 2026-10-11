import SwiftUI
import UniformTypeIdentifiers

@main
@MainActor
struct ThreeWayApp: App {
    @StateObject private var model = LinkModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            LinkScreen(model: model)
                .onChange(of: phase) { _, next in
                    if next == .active { model.setForeground(true) }
                    else if next == .background { model.setForeground(false) }
                }
        }
    }
}

private struct LinkScreen: View {
    @ObservedObject var model: LinkModel
    @State private var importing = false
    @State private var showingConnections = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 9) {
                        Text("YOUR PHONE. YOUR SHARED ROOM.").font(.system(size: 10, weight: .semibold)).tracking(1.6).foregroundStyle(.secondary)
                        Text("Keep the conversation\nconnected.").font(.system(size: 31, weight: .semibold)).tracking(-0.9)
                        Text("Start here, then continue on your website.").font(.subheadline).foregroundStyle(.secondary)
                    }.padding(.vertical, 12)
                    LinkCard {
                        HStack(alignment: .top, spacing: 13) {
                            Image(systemName: model.connected ? "checkmark.icloud.fill" : "icloud")
                                .font(.title2).foregroundStyle(model.connected ? Color.green : Color.secondary)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(model.status).font(.headline)
                                Text(model.detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if model.profile == nil {
                            Button("Import phone setup", systemImage: "square.and.arrow.down") { importing = true }.buttonStyle(.borderedProminent).tint(.primary)
                        } else {
                            HStack {
                                Button(model.wantsConnection ? "Disconnect" : "Connect", systemImage: model.wantsConnection ? "stop.fill" : "link") {
                                    if model.wantsConnection { model.disconnect() } else { model.connect() }
                                }.buttonStyle(.borderedProminent).tint(.primary)
                                if let profile = model.profile {
                                    ShareLink(item: profile.website) { Label("Website link", systemImage: "square.and.arrow.up") }.buttonStyle(.bordered)
                                }
                            }
                        }
                        Divider()
                        Text("Keep this app open while connected. Your laptop can be off.").font(.caption).foregroundStyle(.secondary)
                    }
                    LinkCard {
                        HStack { Text("Connection test messages").font(.headline); Spacer(); Text("\(model.messages.count)").font(.caption).foregroundStyle(.secondary) }
                        if model.messages.isEmpty {
                            Text("Send a message here or on the website to check the connection.").font(.subheadline).foregroundStyle(.secondary).padding(.vertical, 12)
                        }
                        ForEach(model.messages) { message in
                            VStack(alignment: .leading, spacing: 6) {
                                Label(message.title, systemImage: message.source == "iphone" ? "iphone" : "globe").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                Text(message.text).font(.subheadline).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(13).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 13))
                        }
                        Divider()
                        TextField("Try: Hello from my iPhone", text: $model.draft, axis: .vertical)
                            .lineLimit(2...5).textFieldStyle(.plain).padding(13)
                            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 13))
                        HStack {
                            Text(model.notice).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button(model.pending == nil ? "Send ↑" : "Retry ↑") { Task { await model.send() } }
                                .buttonStyle(.borderedProminent).tint(.primary)
                                .disabled(!model.connected || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    Text("This build connects your phone and Cloudflare. GPT and Claude connections come later. The latest 100 test messages are stored privately on Cloudflare and copied to this phone.")
                        .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 4)
                }.padding(20)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Three Way")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Connections", systemImage: "slider.horizontal.3") { showingConnections = true } } }
            .sheet(isPresented: $showingConnections) {
                NavigationStack {
                    Form {
                        Section("Phone connection") {
                            LabeledContent("Website", value: "three-way-chat")
                            LabeledContent("Connection", value: model.connected ? "Connected" : "Offline")
                            Toggle("Keep screen awake while connected", isOn: $model.keepScreenOn)
                            Button("Import updated phone setup") { showingConnections = false; importing = true }
                        }
                        Section("Assistant connections") { Text("Not included in this connection build.").foregroundStyle(.secondary) }
                        Section { Text("Pairing keys stay in the iPhone Keychain. The private website link pairs a browser for eight hours. Share it only with people who may read and send test messages.").font(.caption) }
                    }.navigationTitle("Connections").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingConnections = false } } }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
                do { if let file = try result.get().first { try model.importProfile(from: file) } }
                catch { model.notice = "Could not import the setup file. Choose the Three Way Phone Setup JSON file." }
            }
        }
    }
}

private struct LinkCard<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.primary.opacity(0.055), lineWidth: 1))
    }
}
