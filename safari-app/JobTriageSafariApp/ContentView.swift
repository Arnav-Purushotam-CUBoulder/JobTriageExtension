import SafariServices
import SwiftUI

struct ContentView: View {
  @State private var status = "Enable the extension in Safari Settings > Extensions."

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Job Triage Safari")
        .font(.title2)
        .bold()

      Text("This app hosts the Safari extension.")
      Text("After enabling, browse any job page and the extension widget will scan and analyze it.")
        .foregroundStyle(.secondary)

      Button("Open Safari Extension Settings") {
        openExtensionPreferences()
      }

      Text(status)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
    .padding(20)
    .frame(width: 480)
  }

  private func openExtensionPreferences() {
    guard let extensionBundleIdentifier = Bundle.main.object(forInfoDictionaryKey: "EXTENSION_BUNDLE_IDENTIFIER") as? String,
          !extensionBundleIdentifier.isEmpty else {
      status = "Missing extension bundle identifier in Info.plist."
      return
    }

    SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
      DispatchQueue.main.async {
        if let error {
          status = "Could not open Safari preferences: \(error.localizedDescription)"
          return
        }
        status = "Safari settings opened. Enable Job Triage Safari Extension."
      }
    }
  }
}
