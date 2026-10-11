import SwiftUI
import WebKit

struct DashboardView: UIViewRepresentable {
    @ObservedObject var model: LinkModel
    @Binding var exportURL: URL?
    func makeCoordinator() -> Coordinator { Coordinator(model: model, exported: $exportURL) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "threeway")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false; view.backgroundColor = UIColor(red: 0.97, green: 0.98, blue: 0.96, alpha: 1)
        view.scrollView.bounces = false
        if let index = context.coordinator.index {
            view.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "threeway")
    }
    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let model: LinkModel
        let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Dashboard")
        @Binding var exported: URL?
        init(model: LinkModel, exported: Binding<URL?>) { self.model = model; _exported = exported }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, let index,
                  url.isFileURL, url.standardizedFileURL == index.standardizedFileURL else {
                decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, let index,
                  url.isFileURL, url.standardizedFileURL == index.standardizedFileURL,
                  let input = message.body as? [String: Any], let id = input["id"] as? String,
                  UUID(uuidString: id) != nil, let action = input["action"] as? String,
                  let body = input["body"] as? [String: Any] else { return }
            let reply: HostReply
            if action == "share" {
                let result = model.store.handle(action: "export", body: [:])
                if result.status == 200 {
                    do {
                        let path = FileManager.default.temporaryDirectory.appendingPathComponent("Three-Way-Conversations.json")
                        try JSONSerialization.data(withJSONObject: result.body, options: .prettyPrinted)
                            .write(to: path, options: [.atomic, .completeFileProtection])
                        exported = path; reply = HostReply(["ok": true])
                    } catch { reply = HostReply(["error": "Could not export your conversations."], status: 500) }
                } else { reply = result }
            } else { reply = model.store.handle(action: action, body: body) }
            guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "status": reply.status, "body": reply.body]) else { return }
            // Only base64 enters JavaScript. Prompt text never becomes code.
            message.webView?.evaluateJavaScript("window.threeWayReceive('" + data.base64EncodedString() + "')", completionHandler: nil)
        }
    }
}
struct ConversationShare: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ view: UIActivityViewController, context: Context) {}
}
