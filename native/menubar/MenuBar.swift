// MacRecorder 메뉴바 앱 — 화면 오른쪽 위 아이콘.
// 녹화 자체는 서버(127.0.0.1:<port>)가 한다. 이 앱은 서버 API 를 부르는 리모컨이다.
// 단축키 ⌃⌥⌘R: 어느 앱에 있든 녹화 시작/정지.
import AppKit
import Carbon.HIToolbox
import SwiftUI

// MARK: - 서버 통신

struct Api {
  static var port: Int {
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mac-recorder/config.json")
    if let d = try? Data(contentsOf: url), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
       let p = j["port"] as? Int { return p }
    return 7931
  }
  static var base: String { "http://127.0.0.1:\(port)" }

  static func call(_ path: String, method: String = "GET", body: [String: Any]? = nil, timeout: Double = 10) async throws -> [String: Any] {
    var req = URLRequest(url: URL(string: "\(base)/api/\(path)")!, timeoutInterval: timeout)
    req.httpMethod = method
    if let b = body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: b)
    }
    let (data, resp) = try await URLSession.shared.data(for: req)
    let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    if let h = resp as? HTTPURLResponse, h.statusCode >= 400 {
      throw NSError(domain: "api", code: h.statusCode, userInfo: [NSLocalizedDescriptionKey: j["error"] as? String ?? "HTTP \(h.statusCode)"])
    }
    return j
  }
}

struct Device: Identifiable, Hashable { let id: String; let name: String; let main: Bool }
struct Recent: Identifiable, Hashable { let id: String; let title: String }

// MARK: - 상태

@MainActor
final class Model: ObservableObject {
  @Published var online = false
  @Published var recording = false
  @Published var starting = false
  @Published var elapsed = 0
  @Published var video = true
  @Published var mic = true
  @Published var system = false
  @Published var display = "all"
  @Published var micId = ""
  @Published var displays: [Device] = []
  @Published var mics: [Device] = []
  @Published var recents: [Recent] = []
  @Published var busy = false
  @Published var lastError: String? = nil
  @Published var proposals = 0
  private var tick = 0

  init() {
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.poll() }
    }
    poll()
  }

  func poll() {
    tick += 1
    Task {
      do {
        let s = try await Api.call("status", timeout: 3)
        online = true
        if let a = s["active"] as? [String: Any] {
          recording = true
          elapsed = a["elapsedSec"] as? Int ?? 0
          starting = (a["state"] as? String) == "starting"
        } else { recording = false; elapsed = 0; starting = false }
        if let r = s["record"] as? [String: Any] {
          video = r["video"] as? Bool ?? true; mic = r["mic"] as? Bool ?? true; system = r["system"] as? Bool ?? false
          display = (r["display"] as? String) ?? String(describing: r["display"] ?? "all")
          micId = r["micId"] as? String ?? ""
        }
        proposals = s["proposals"] as? Int ?? 0
        if tick == 1 || tick % 5 == 0 { await loadRecents() }
        if tick == 1 || tick % 120 == 0 || displays.isEmpty { await loadDevices() }
      } catch {
        online = false; recording = false
      }
    }
  }

  func loadRecents() async {
    guard let j = try? await Api.call("sessions"), let list = j["sessions"] as? [[String: Any]] else { return }
    recents = list.prefix(6).compactMap { s in
      guard let id = s["id"] as? String else { return nil }
      let t = (s["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? Model.label(id)
      return Recent(id: id, title: t)
    }
  }
  static func label(_ id: String) -> String {
    // 20261112-150000 → 11/12 15:00
    let c = Array(id)
    guard c.count >= 15 else { return id }
    return "\(String(c[4...5]))/\(String(c[6...7])) \(String(c[9...10])):\(String(c[11...12]))"
  }

  func loadDevices() async {
    guard let j = try? await Api.call("devices", timeout: 15) else { return }
    displays = (j["displays"] as? [[String: Any]] ?? []).map {
      Device(id: String(describing: $0["id"] ?? ""), name: $0["name"] as? String ?? "화면", main: $0["main"] as? Bool ?? false)
    }
    mics = (j["mics"] as? [[String: Any]] ?? []).map {
      Device(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "마이크", main: $0["default"] as? Bool ?? false)
    }
  }

  func toggle() {
    guard !busy else { return }
    busy = true
    Task {
      do {
        let r = try await Api.call("toggle", method: "POST", body: [:], timeout: 20)
        lastError = nil
        if (r["action"] as? String) == "stopped" { NSSound(named: "Pop")?.play() } else { NSSound(named: "Tink")?.play() }
      } catch {
        lastError = error.localizedDescription
        NSSound.beep()
        alert("녹화를 시작하지 못했습니다", error.localizedDescription)
      }
      busy = false
      poll()
    }
  }

  func setRecord(_ patch: [String: Any]) {
    Task { _ = try? await Api.call("config", method: "PUT", body: ["record": patch]); poll() }
  }

  func open(_ hash: String = "") {
    if let u = URL(string: "\(Api.base)/\(hash)") { NSWorkspace.shared.open(u) }
  }
  func openFolder() { Task { _ = try? await Api.call("open", method: "POST", body: ["what": "recordings"]) } }

  func restartServer() {
    // pm2 로 띄운 서버를 다시 시작한다. 로그인 셸로 실행해 사용자의 PATH(node·pm2)를 쓴다.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "pm2 restart mac-recorder || pm2 resurrect"]
    try? p.run()
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.poll() }
  }

  func alert(_ title: String, _ msg: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = msg + (msg.contains("권한") ? "\n\n시스템 설정 → 개인정보 보호 및 보안에서 «MacRecorder Capture»를 허용한 뒤 다시 시도하세요." : "")
    a.addButton(withTitle: "확인")
    if msg.contains("권한") { a.addButton(withTitle: "시스템 설정 열기") }
    NSApp.activate(ignoringOtherApps: true)
    if a.runModal() == .alertSecondButtonReturn,
       let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
      NSWorkspace.shared.open(u)
    }
  }

  var elapsedText: String {
    let h = elapsed / 3600, m = (elapsed % 3600) / 60, s = elapsed % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
  }
  var sourcesText: String {
    [video ? "화면" : nil, mic ? "마이크" : nil, system ? "시스템 소리" : nil].compactMap { $0 }.joined(separator: "·")
  }
}

// MARK: - 전역 단축키 ⌃⌥⌘R

final class HotKey {
  static var onPress: (() -> Void)?
  private var ref: EventHotKeyRef?
  init() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
      DispatchQueue.main.async { HotKey.onPress?() }
      return noErr
    }, 1, &spec, nil, nil)
    let id = EventHotKeyID(signature: OSType(0x4D52_4543), id: 1) // 'MREC'
    RegisterEventHotKey(UInt32(kVK_ANSI_R), UInt32(cmdKey | optionKey | controlKey), id, GetApplicationEventTarget(), 0, &ref)
  }
}

// MARK: - 화면

struct MenuContent: View {
  @EnvironmentObject var m: Model

  var body: some View {
    if !m.online {
      Text("⚠️ 서버에 연결할 수 없음 (127.0.0.1:\(Api.port))")
      Button("서버 다시 시작") { m.restartServer() }
      Divider()
    } else if m.recording {
      Text(m.starting ? "● 녹화 시작 중…" : "● 녹화 중 \(m.elapsedText) — \(m.sourcesText)")
      Button("녹화 정지") { m.toggle() }.keyboardShortcut("r", modifiers: [.control, .option, .command])
      Divider()
    } else {
      Button("녹화 시작 (\(m.sourcesText.isEmpty ? "소스 없음" : m.sourcesText))") { m.toggle() }
        .keyboardShortcut("r", modifiers: [.control, .option, .command])
        .disabled(m.sourcesText.isEmpty)
      Toggle("화면", isOn: Binding(get: { m.video }, set: { m.setRecord(["video": $0]) }))
      Toggle("마이크", isOn: Binding(get: { m.mic }, set: { m.setRecord(["mic": $0]) }))
      Toggle("시스템 소리 (화상회의 상대 목소리)", isOn: Binding(get: { m.system }, set: { m.setRecord(["system": $0]) }))
      if m.displays.count > 1 {
        Menu("녹화할 화면") {
          Toggle("전체 화면 (\(m.displays.count)개)", isOn: Binding(get: { m.display == "all" }, set: { _ in m.setRecord(["display": "all"]) }))
          ForEach(m.displays) { d in
            Toggle(d.name + (d.main ? " (주)" : ""), isOn: Binding(get: { m.display == d.id }, set: { _ in m.setRecord(["display": d.id]) }))
          }
        }
      }
      if !m.mics.isEmpty {
        Menu("마이크 선택") {
          Toggle("시스템 기본", isOn: Binding(get: { m.micId.isEmpty }, set: { _ in m.setRecord(["micId": ""]) }))
          ForEach(m.mics) { d in
            Toggle(d.name, isOn: Binding(get: { m.micId == d.id }, set: { _ in m.setRecord(["micId": d.id]) }))
          }
        }
      }
      Divider()
    }
    if !m.recents.isEmpty {
      Menu("최근 녹화") {
        ForEach(m.recents) { r in Button(r.title) { m.open("#s=\(r.id)") } }
      }
    }
    Button("대시보드 열기") { m.open() }
    Button("녹화 폴더 열기") { m.openFolder() }
    if m.proposals > 0 { Button("교정 제안 \(m.proposals)개 확인") { m.open("#dict") } }
    Divider()
    Button("설정·권한") { m.open("#settings") }
    Button("MacRecorder 메뉴 닫기") { NSApp.terminate(nil) }
  }
}

@main
struct MacRecorderApp: App {
  @StateObject private var model = Model()
  private let hotkey: HotKey

  init() {
    hotkey = HotKey()
  }

  var body: some Scene {
    MenuBarExtra {
      MenuContent().environmentObject(model)
        .onAppear { HotKey.onPress = { [weak model] in model?.toggle() } }
    } label: {
      HStack(spacing: 3) {
        Image(nsImage: IconArt.menuBar(recording: model.recording, pulse: model.elapsed % 2 == 1))
        if model.recording { Text(model.elapsedText).monospacedDigit() }
      }
      .task { HotKey.onPress = { [weak model] in model?.toggle() } }
    }
    .menuBarExtraStyle(.menu)
  }
}
