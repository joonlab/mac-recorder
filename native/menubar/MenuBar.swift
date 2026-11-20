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
/// 녹화할 수 있는 창
struct Win: Identifiable, Hashable { let id: Int; let app: String; let title: String; let browser: Bool }
/// 진행 중인 창·탭 녹화
struct Live: Identifiable, Hashable { let id: String; let label: String; let paused: Bool; let elapsed: Int }

// MARK: - 상태

@MainActor
final class Model: ObservableObject {
  @Published var online = false
  @Published var recording = false
  @Published var starting = false
  @Published var paused = false
  @Published var pauseReason: String? = nil
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
  @Published var notice: String? = nil   // 녹화 중 화면 변화(모니터 분리 등) 마지막 기록
  @Published var live: [Live] = []
  @Published var windows: [Win] = []
  private var windowsAt = Date.distantPast
  private var tick = 0

  init() {
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.poll() }
    }
    // 모니터를 꽂거나 빼면 바로 서버에 알린다 → 대시보드가 새로고침 없이 화면 목록을 다시 읽는다
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in
        // 화면 목록이 자리 잡을 때까지 잠깐 기다린다(연결 직후엔 아직 안 보일 수 있다)
        try? await Task.sleep(nanoseconds: 300_000_000)
        _ = try? await Api.call("displays-changed", method: "POST", body: [:], timeout: 15)
        await self?.loadDevices()
      }
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
          paused = a["paused"] as? Bool ?? false
          pauseReason = a["pauseReason"] as? String
          notice = Model.noticeText((a["events"] as? [[String: Any]])?.last)
        } else { recording = false; elapsed = 0; starting = false; paused = false; notice = nil }
        if let r = s["record"] as? [String: Any] {
          video = r["video"] as? Bool ?? true; mic = r["mic"] as? Bool ?? true; system = r["system"] as? Bool ?? false
          display = (r["display"] as? String) ?? String(describing: r["display"] ?? "all")
          micId = r["micId"] as? String ?? ""
        }
        proposals = s["proposals"] as? Int ?? 0
        live = (s["live"] as? [[String: Any]] ?? []).compactMap { e in
          guard let id = e["id"] as? String else { return nil }
          let w = e["window"] as? [String: Any]
          let t = e["title"] as? String ?? ""
          let label = (e["kind"] as? String) == "window" ? "창 · \(w?["app"] as? String ?? "") — \(t)" : "탭 · \(t)"
          return Live(id: id, label: String(label.prefix(60)), paused: e["paused"] as? Bool ?? false, elapsed: e["recordedSec"] as? Int ?? 0)
        }
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
  /// «으로/로»: 받침이 있으면(ㄹ 받침 제외) «으로»
  static func ro(_ n: String) -> String {
    guard let u = n.unicodeScalars.last?.value, u >= 0xAC00, u <= 0xD7A3 else { return n + "로" }
    let j = (u - 0xAC00) % 28
    return n + (j != 0 && j != 8 ? "으로" : "로")
  }

  static func noticeText(_ e: [String: Any]?) -> String? {
    guard let e, let t = e["type"] as? String else { return nil }
    let n = e["name"] as? String ?? "화면"
    switch t {
    case "primary-moved": return "\(ro(n)) 옮겨 계속 녹화 중"
    case "primary-lost": return "\(n) 연결 끊김 — 다시 연결을 기다리는 중"
    case "primary-returned", "primary-resumed": return "\(n)에서 녹화 중"
    case "display-lost": return "\(n) 분리됨 — 녹화는 계속"
    case "display-resumed": return "\(n) 다시 연결 — 이어서 녹화"
    case "display-added": return "\(n) 연결 — 녹화에 추가"
    default: return nil
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
    let kinds = ["builtin": "내장", "bluetooth": "블루투스", "usb": "USB", "virtual": "가상 장치", "aggregate": "묶음 장치", "display": "모니터", "thunderbolt": "Thunderbolt"]
    mics = (j["mics"] as? [[String: Any]] ?? [])
      .sorted { (($0["kind"] as? String) == "virtual" ? 1 : 0) < (($1["kind"] as? String) == "virtual" ? 1 : 0) }
      .map {
        let k = kinds[$0["kind"] as? String ?? ""].map { " · \($0)" } ?? ""
        return Device(id: $0["id"] as? String ?? "", name: ($0["name"] as? String ?? "마이크") + k, main: $0["default"] as? Bool ?? false)
      }
  }

  /// 메뉴를 열 때 창 목록을 읽는다(3초 안에 다시 열면 그대로)
  func loadWindows(force: Bool = false) {
    guard force || Date().timeIntervalSince(windowsAt) > 3 else { return }
    windowsAt = Date()
    Task {
      guard let j = try? await Api.call("windows", timeout: 15), let list = j["windows"] as? [[String: Any]] else { return }
      windows = list.compactMap { w in
        guard let id = w["id"] as? Int else { return nil }
        let t = (w["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "(제목 없음)"
        return Win(id: id, app: w["app"] as? String ?? "?", title: String(t.prefix(60)), browser: w["browser"] as? Bool ?? false)
      }
    }
  }
  var windowApps: [String] { Array(Set(windows.map(\.app))).sorted() }

  func startWindow(_ w: Win) {
    Task {
      do {
        _ = try await Api.call("windows/start", method: "POST", body: ["windowId": w.id], timeout: 20)
        NSSound(named: "Tink")?.play()
      } catch {
        NSSound.beep()
        alert("창 녹화를 시작하지 못했습니다", error.localizedDescription)
      }
      poll()
    }
  }
  func controlLive(_ id: String, _ action: String) {
    Task {
      _ = try? await Api.call("live/\(id)/\(action)", method: "POST", body: [:], timeout: 10)
      NSSound(named: action == "stop" ? "Pop" : "Bottle")?.play()
      poll()
    }
  }
  static func clock(_ sec: Int) -> String {
    let h = sec / 3600, m = (sec % 3600) / 60, s = sec % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
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

  func togglePause() {
    guard recording, !busy else { return }
    busy = true
    Task {
      do {
        let r = try await Api.call("pause", method: "POST", body: [:], timeout: 10)
        NSSound(named: (r["paused"] as? Bool) == true ? "Bottle" : "Tink")?.play()
      } catch { NSSound.beep() }
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
  static var onPress: (() -> Void)?        // ⌃⌥⌘R 녹화 시작·정지
  static var onPause: (() -> Void)?        // ⌃⌥⌘P 일시정지·다시 녹화
  private var refs: [EventHotKeyRef?] = [nil, nil]
  init() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, ev, _ in
      var hk = EventHotKeyID()
      GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                        MemoryLayout<EventHotKeyID>.size, nil, &hk)
      DispatchQueue.main.async { if hk.id == 2 { HotKey.onPause?() } else { HotKey.onPress?() } }
      return noErr
    }, 1, &spec, nil, nil)
    let mods = UInt32(cmdKey | optionKey | controlKey)
    RegisterEventHotKey(UInt32(kVK_ANSI_R), mods, EventHotKeyID(signature: OSType(0x4D52_4543), id: 1), GetApplicationEventTarget(), 0, &refs[0])
    RegisterEventHotKey(UInt32(kVK_ANSI_P), mods, EventHotKeyID(signature: OSType(0x4D52_4543), id: 2), GetApplicationEventTarget(), 0, &refs[1])
  }
}

// MARK: - 화면

struct MenuContent: View {
  @EnvironmentObject var m: Model

  var body: some View {
    Group { items }.onAppear { m.loadWindows() }   // 메뉴가 열릴 때 창 목록을 새로 읽는다
  }

  @ViewBuilder var items: some View {
    if !m.online {
      Text("⚠️ 서버에 연결할 수 없음 (127.0.0.1:\(Api.port))")
      Button("서버 다시 시작") { m.restartServer() }
      Divider()
    } else if m.recording {
      Text(m.starting ? "● 녹화 시작 중…" : (m.paused ? "⏸ 일시정지 \(m.elapsedText) — 지금은 녹화되지 않음" : "● 녹화 중 \(m.elapsedText) — \(m.sourcesText)"))
      if m.paused, let r = m.pauseReason, r != "manual" {
        Text(r == "sleep" ? "↳ 잠자기로 자동 일시정지됨 — «다시 녹화»를 누르면 이어집니다" : "↳ 화면 잠금으로 자동 일시정지됨 — «다시 녹화»를 누르면 이어집니다")
      }
      if let n = m.notice, !m.paused { Text("↳ \(n)") }
      Button(m.paused ? "다시 녹화" : "일시정지") { m.togglePause() }.keyboardShortcut("p", modifiers: [.control, .option, .command])
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
    if !m.live.isEmpty {
      Text("창·탭 녹화 \(m.live.count)개")
      ForEach(m.live) { e in
        Menu("\(e.paused ? "⏸" : "●") \(Model.clock(e.elapsed))  \(e.label)") {
          Button(e.paused ? "다시 녹화" : "일시정지") { m.controlLive(e.id, "pause") }
          Button("정지") { m.controlLive(e.id, "stop") }
        }
      }
      Divider()
    }
    if m.online {
      Menu("창 하나만 녹화") {
        if m.windows.isEmpty { Text("창 목록을 읽는 중…") }
        ForEach(m.windowApps, id: \.self) { app in
          let ws = m.windows.filter { $0.app == app }
          Menu(app + (ws.first?.browser == true ? " (맥 전체 소리)" : "")) {
            ForEach(ws) { w in Button(w.title) { m.startWindow(w) } }
          }
        }
        Divider()
        Button("창 목록 새로고침") { m.loadWindows(force: true) }
        Button("여러 창 고르기 (대시보드)") { m.open() }
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
        .onAppear { HotKey.onPress = { [weak model] in model?.toggle() }; HotKey.onPause = { [weak model] in model?.togglePause() } }
    } label: {
      HStack(spacing: 3) {
        Image(nsImage: IconArt.menuBar(recording: model.recording || !model.live.isEmpty, paused: model.recording ? model.paused : model.live.allSatisfy(\.paused),
                                       pulse: !model.paused && (model.recording ? model.elapsed : (model.live.first?.elapsed ?? 0)) % 2 == 1))
        if model.recording { Text(model.elapsedText).monospacedDigit() }
        else if !model.live.isEmpty { Text("창·탭 \(model.live.count)").monospacedDigit() }
      }
      .task { HotKey.onPress = { [weak model] in model?.toggle() }; HotKey.onPause = { [weak model] in model?.togglePause() } }
    }
    .menuBarExtraStyle(.menu)
  }
}
