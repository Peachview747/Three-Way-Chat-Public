import XCTest

final class DashboardTests: XCTestCase {
    func testBundledDashboardSavesAndRestoresPrompt() {
        let app = XCUIApplication()
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 20))
        let welcome = web.staticTexts["Finally, all in the same room."]
        XCTAssertTrue(welcome.waitForExistence(timeout: 15))
        let input = web.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("Hello from the iPhone dashboard")
        let send = web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Send message")).firstMatch
        XCTAssertTrue(send.isEnabled)
        send.tap()
        let saved = web.staticTexts["Saved on your iPhone. GPT and Claude are not connected yet."]
        XCTAssertTrue(saved.waitForExistence(timeout: 15))
        XCTAssertTrue(web.staticTexts["Hello from the iPhone dashboard"].exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Hello from the iPhone dashboard"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.webViews.staticTexts["Not connected on this iPhone"].firstMatch.exists)
    }
}
