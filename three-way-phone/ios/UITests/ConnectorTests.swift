import XCTest

final class ConnectorTests: XCTestCase {
    func testConnectorLaunchAndSetupCancellation() {
        let app = XCUIApplication()
        app.launch()
        let setup = app.buttons["import-setup"]
        XCTAssertTrue(setup.waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Three Way Connector"].exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "connection-status").firstMatch.exists)
        XCTAssertTrue(app.buttons["connection-button"].exists)
        XCTAssertFalse(app.buttons["connection-button"].isEnabled)
        XCTAssertFalse(app.webViews.firstMatch.exists)
        XCTAssertFalse(app.textViews.firstMatch.exists)
        XCTAssertFalse(app.buttons["Send message"].exists)

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Three Way Connector"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        setup.tap()
        let cancel = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        cancel.tap()
        XCTAssertTrue(setup.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["connection-button"].isEnabled)
        XCTAssertFalse(app.staticTexts["connector-notice"].exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(setup.waitForExistence(timeout: 15))
        XCTAssertFalse(app.webViews.firstMatch.exists)
    }
}
