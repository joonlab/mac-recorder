// MacRecorder Capture — ScreenCaptureKit 녹화 엔진
//
// 화면 + 시스템 소리 + 마이크를 ScreenCaptureKit 으로 동기 캡처해 파일에 담는다.
// 녹화 중 모니터를 빼거나 꽂아도 녹화는 끊기지 않는다(아래 «화면 변화» 절).
//   영상 모드   : recording.mp4  = 비디오 + 시스템 소리(stereo) 트랙 + 마이크(mono) 트랙
//   오디오 모드 : recording.m4a  = 시스템 소리 트랙 + 마이크 트랙 (비디오 없음)
// 트랙을 나눠 두는 이유: 전사할 때 «나(마이크)»와 «상대(시스템 소리)»를 구분할 수 있다.
// 대신 일반 플레이어는 첫 오디오 트랙만 재생하므로, 종료 후 mix-audio.sh 로 재생용 _mixed 파일을 만든다.
//
// 이 바이너리는 반드시 .app 번들 안에서, `open -n` 으로 실행한다.
//   node·터미널이 직접 띄우면 macOS 가 권한(화면 기록·마이크)을 부모 프로세스에 묻는다.
//   `open` 으로 띄우면 이 앱 자신이 책임 프로세스가 되어 권한을 이 앱 하나에만 주면 된다.
//
// 모드
//   --check            권한 상태를 JSON 으로 출력
//   --request          권한 요청 대화상자를 띄우고 결과를 JSON 으로 출력
//   --list             화면·마이크 목록을 JSON 으로 출력
//   (기본)             녹화. SIGINT/SIGTERM 을 받으면 파일을 마무리하고 끝난다.
// 출력은 --json-out <경로> 로 파일에 쓴다(open 으로 실행하면 stdout 을 받기 어렵다).
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - 인자

var outPath = ""
var displayID: UInt32? = nil
var wantMic = true
var wantSystem = true
var wantVideo = true
var scaleWidth = 0
var fps = 30
var micDeviceID: String? = nil
var statusFile: String? = nil
var mixScript: String? = nil
var jsonOut: String? = nil
var allDisplays = false   // --displays all : 연결된 화면 전부(녹화 중 새로 꽂은 화면 포함)
var fallback = true       // --fallback 0 : 주 화면이 사라져도 다른 화면으로 옮기지 않음
var mode = "record"

do {
  let a = CommandLine.arguments
  var i = 1
  func next() -> String { i += 1; return i < a.count ? a[i] : "" }
  while i < a.count {
    switch a[i] {
    case "--check": mode = "check"
    case "--request": mode = "request"
    case "--list": mode = "list"
    case "--out": outPath = next()
    case "--display-id": displayID = UInt32(next())
    case "--mic": wantMic = next() != "0"
    case "--system": wantSystem = next() != "0"
    case "--video": wantVideo = next() != "0"
    case "--width": scaleWidth = Int(next()) ?? 0
    case "--fps": fps = max(1, Int(next()) ?? 30)
    case "--mic-id": let v = next(); micDeviceID = v.isEmpty ? nil : v
    case "--status-file": statusFile = next()
    case "--mix-script": mixScript = next()
    case "--json-out": jsonOut = next()
    case "--displays": allDisplays = next() == "all"
    case "--fallback": fallback = next() != "0"
    default: break
    }
    i += 1
  }
}

func log(_ s: String) {
  let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
  FileHandle.standardError.write(("[\(f.string(from: Date()))] " + s + "\n").data(using: .utf8)!)
}

func emitJSON(_ obj: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])) ?? Data("{}".utf8)
  if let p = jsonOut { try? data.write(to: URL(fileURLWithPath: p)) } else { FileHandle.standardOutput.write(data) }
}

/// 상태 파일 — 서버가 읽어 녹화 중/실패/완료를 판단한다.
var statusBase: [String: Any] = [:]
func writeStatus(_ state: String, _ extra: [String: Any] = [:]) {
  guard let p = statusFile else { return }
  var o = statusBase
  o["state"] = state
  o["pid"] = Int(getpid())
  o["updatedAt"] = ISO8601DateFormatter().string(from: Date())
  for (k, v) in extra { o[k] = v }
  statusBase = o
  if let d = try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys]) {
    try? d.write(to: URL(fileURLWithPath: p), options: .atomic)
  }
}

// MARK: - 권한·목록

func micStatusString() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

func permissionReport() -> [String: Any] {
  ["screen": CGPreflightScreenCaptureAccess(), "microphone": micStatusString(),
   "macos": ProcessInfo.processInfo.operatingSystemVersionString]
}

func displayList() -> [[String: Any]] {
  var out: [[String: Any]] = []
  let mainID = CGMainDisplayID()
  for s in NSScreen.screens {
    guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
    let id = n.uint32Value
    let builtin = CGDisplayIsBuiltin(id) != 0
    out.append([
      "id": Int(id), "name": builtin ? "내장 디스플레이" : s.localizedName,
      "width": Int(CGDisplayPixelsWide(id)), "height": Int(CGDisplayPixelsHigh(id)),
      "main": id == mainID, "builtin": builtin,
    ])
  }
  return out
}

func micList() -> [[String: Any]] {
  let session = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified)
  let def = AVCaptureDevice.default(for: .audio)?.uniqueID
  return session.devices.map { ["id": $0.uniqueID, "name": $0.localizedName, "default": $0.uniqueID == def] }
}

if mode == "check" { emitJSON(permissionReport()); exit(0) }
if mode == "list" { emitJSON(["displays": displayList(), "mics": micList()]); exit(0) }
if mode == "request" {
  // 화면 기록: 대화상자를 띄우고(처음 한 번), 허용 여부는 앱을 다시 실행해야 반영된다.
  _ = CGRequestScreenCaptureAccess()
  let sem = DispatchSemaphore(value: 0)
  AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
  _ = sem.wait(timeout: .now() + 120)
  emitJSON(permissionReport())
  exit(0)
}

// MARK: - 녹화

guard !outPath.isEmpty else { log("--out 필요"); exit(64) }
let outDir = (outPath as NSString).deletingLastPathComponent

/// 녹화가 끝난 뒤 재생용 믹스 파일을 만든다(마이크+시스템 소리가 둘 다 있을 때만).
@Sendable func spawnMixer(_ media: String) {
  guard wantMic, wantSystem, let script = mixScript, FileManager.default.isExecutableFile(atPath: script) else { return }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/bash")
  p.arguments = [script, media]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  do { try p.run(); log("mixer pid=\(p.processIdentifier)") } catch { log("mixer error: \(error)") }
}

// MARK: - 화면 정보

func onlineDisplayIDs() -> [UInt32] {
  var n: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &n) == .success, n > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
  guard CGGetActiveDisplayList(n, &ids, &n) == .success else { return [] }
  return Array(ids.prefix(Int(n)))
}
let isBuiltin = { (id: UInt32) in CGDisplayIsBuiltin(id) != 0 }

/// 화면 이름 — 연결돼 있을 때 정해 두고, 빠진 뒤에는 기억해 둔 이름을 쓴다.
/// 이 프로세스의 NSScreen 목록은 시작 이후 갱신되지 않는다(백그라운드 프로세스라 화면 변경 알림을 받지 못함, 실측).
/// 그래서 처음 보는 화면은 이 앱을 --list 로 짧게 한 번 더 실행해 최신 이름을 받는다.
var displayNames: [UInt32: String] = [:]
var realNames: Set<UInt32> = []
var nameTries: [UInt32: Int] = [:]   // 화면마다 이름 읽기 최대 3번(막 연결된 직후엔 목록에 아직 없을 수 있다)
func setName(_ id: UInt32, _ name: String, real: Bool) {
  if realNames.contains(id) { return }            // 확정된 이름은 덮어쓰지 않는다
  if !real && displayNames[id] != nil { return }
  displayNames[id] = name
  if real { realNames.insert(id) }
}
func rememberName(_ id: UInt32) {
  guard onlineDisplayIDs().contains(id) else { return }
  if isBuiltin(id) { setName(id, "내장 디스플레이", real: true); return }
  for s in NSScreen.screens {
    if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, n.uint32Value == id {
      setName(id, s.localizedName, real: true); return
    }
  }
  setName(id, "외장 모니터 \(CGDisplayPixelsWide(id))×\(CGDisplayPixelsHigh(id))", real: false)
}
/// 이름을 모르는 화면이 있으면 새 프로세스로 화면 목록을 다시 읽는다(약 0.3초).
func refreshNames(_ ids: Set<UInt32>) {
  let todo = ids.filter { !realNames.contains($0) && nameTries[$0, default: 0] < 3 }
  guard !todo.isEmpty, let exe = Bundle.main.executablePath else { return }
  for id in todo { nameTries[id, default: 0] += 1 }
  let tmp = NSTemporaryDirectory() + "macrec-names-\(getpid()).json"
  let p = Process()
  p.executableURL = URL(fileURLWithPath: exe)
  p.arguments = ["--list", "--json-out", tmp]
  p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
  guard (try? p.run()) != nil else { return }
  let deadline = Date().addingTimeInterval(3)
  while p.isRunning && Date() < deadline { usleep(50_000) }
  if p.isRunning { p.terminate() }
  defer { try? FileManager.default.removeItem(atPath: tmp) }
  guard let d = FileManager.default.contents(atPath: tmp),
        let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
        let list = j["displays"] as? [[String: Any]] else { return }
  for x in list { if let id = x["id"] as? Int, let n = x["name"] as? String { setName(UInt32(id), n, real: true) } }
}
func displayName(_ id: UInt32) -> String {
  if displayNames[id] == nil { rememberName(id) }
  return displayNames[id] ?? "화면 \(id)"
}

/// 같은 모니터인지 알아보는 값. 다시 꽂으면 화면 ID 가 바뀔 수 있어서(포트·허브가 바뀌거나 가상 모니터)
/// ID 대신 제조사·모델·일련번호로 «돌아온 모니터»를 찾는다.
struct Fingerprint: Equatable { let vendor: UInt32, model: UInt32, serial: UInt32 }
func fingerprint(_ id: UInt32) -> Fingerprint {
  Fingerprint(vendor: CGDisplayVendorNumber(id), model: CGDisplayModelNumber(id), serial: CGDisplaySerialNumber(id))
}

/// 화면의 실제 픽셀 크기(레티나 포함). SCDisplay.width 는 포인트 단위라 그대로 쓰면 흐려진다.
func pixelSize(_ d: SCDisplay) -> (Int, Int) {
  if let m = CGDisplayCopyDisplayMode(d.displayID), m.pixelWidth > 0 { return (m.pixelWidth, m.pixelHeight) }
  return (d.width, d.height)
}
func scaledSize(_ w: Int, _ h: Int, _ targetW: Int) -> (Int, Int) {
  let tw = targetW > 0 && targetW < w ? targetW : w
  let th = Int((Double(h) * Double(tw) / Double(w)).rounded(.down))
  return (tw & ~1, th & ~1)
}

// MARK: - 기록(상태 파일의 events)

let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
/// 지금 시각을 녹화 시간축(파일의 0초 = 주 녹화 시작)의 초로. 합본에서 화면이 빠진 구간을 정확히 자르는 데 쓴다.
func nowOnTimeline() -> Double? {
  guard let st = timeline.start else { return nil }
  // 일시정지 중이면 멈춘 시점, 아니면 지금. 둘 다 멈춰 있던 시간을 뺀 «파일 안의 시각»
  let raw = timeline.pausedAt ?? CMClockGetTime(CMClockGetHostTimeClock())
  return CMTimeGetSeconds(CMTimeSubtract(CMTimeSubtract(raw, timeline.offset), st))
}
let eventsLock = NSLock()
var events: [[String: Any]] = []
func eventSnapshot() -> [[String: Any]] { eventsLock.lock(); defer { eventsLock.unlock() }; return events }
func event(_ type: String, _ display: UInt32?, _ detail: String = "", file: String? = nil) {
  var e: [String: Any] = ["at": iso.string(from: Date()), "type": type]
  if let t = nowOnTimeline() { e["t"] = (max(0, t) * 1000).rounded() / 1000 }
  if let f = file { e["file"] = f }
  if let d = display { e["display"] = Int(d); e["name"] = displayName(d) }
  if !detail.isEmpty { e["detail"] = detail }
  eventsLock.lock(); events.append(e); eventsLock.unlock()
  log("event \(type) display=\(display.map(String.init) ?? "-") \(detail)")
}

// MARK: - 공통 시간축

/// 모든 파일이 같은 시각에서 시작하고 같은 시각에 끝나게 한다.
/// 나중에 연결된 화면의 파일도 앞부분이 비어 있을 뿐 시간축은 주 녹화와 같다 → 합본이 어긋나지 않는다.
final class Timeline {
  private let lock = NSLock()
  private var _start: CMTime? = nil
  private var _latest = CMTime.invalid
  // 일시정지: 멈춘 시간을 누적해 두고, 다시 시작한 뒤의 모든 샘플 시각에서 뺀다 → 파일에는 멈춘 구간이 없다
  private var _offset = CMTime.zero
  private var _pausedAt: CMTime? = nil
  var start: CMTime? { lock.lock(); defer { lock.unlock() }; return _start }
  func startIfNil(_ t: CMTime) -> CMTime { lock.lock(); defer { lock.unlock() }; if _start == nil { _start = t }; return _start! }
  func bump(_ t: CMTime) { lock.lock(); if !_latest.isValid || t > _latest { _latest = t }; lock.unlock() }
  var latest: CMTime? { lock.lock(); defer { lock.unlock() }; return _latest.isValid ? _latest : nil }
  var offset: CMTime { lock.lock(); defer { lock.unlock() }; return _offset }
  var isPaused: Bool { lock.lock(); defer { lock.unlock() }; return _pausedAt != nil }
  var pausedAt: CMTime? { lock.lock(); defer { lock.unlock() }; return _pausedAt }
  func pause(_ now: CMTime) { lock.lock(); if _pausedAt == nil { _pausedAt = now }; lock.unlock() }
  /// 다시 시작. 이번에 멈춰 있던 시간(초)을 돌려준다
  func resume(_ now: CMTime) -> Double {
    lock.lock(); defer { lock.unlock() }
    guard let p = _pausedAt else { return 0 }
    let d = CMTimeSubtract(now, p)
    _offset = CMTimeAdd(_offset, d); _pausedAt = nil
    return CMTimeGetSeconds(d)
  }
  var pausedTotal: Double { lock.lock(); defer { lock.unlock() }; return CMTimeGetSeconds(_offset) }
}
let hostNow = { CMClockGetTime(CMClockGetHostTimeClock()) }

/// 샘플 시각을 일시정지로 멈췄던 시간만큼 앞으로 당긴 복사본
func retimed(_ sb: CMSampleBuffer, by off: CMTime) -> CMSampleBuffer? {
  var n: CMItemCount = 0
  CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: 0, arrayToFill: nil, entriesNeededOut: &n)
  guard n > 0 else { return sb }
  var infos = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: n)
  CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: n, arrayToFill: &infos, entriesNeededOut: &n)
  for i in 0..<infos.count {
    if infos[i].presentationTimeStamp.isValid { infos[i].presentationTimeStamp = CMTimeSubtract(infos[i].presentationTimeStamp, off) }
    if infos[i].decodeTimeStamp.isValid { infos[i].decodeTimeStamp = CMTimeSubtract(infos[i].decodeTimeStamp, off) }
  }
  var out: CMSampleBuffer?
  guard CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sb, sampleTimingEntryCount: n, sampleTimingArray: &infos, sampleBufferOut: &out) == noErr else { return nil }
  return out
}
let timeline = Timeline()

// MARK: - 화면 하나의 녹화

/// 주 녹화(primary): 소리를 함께 담는다. 대상 화면이 사라지면 남은 화면으로 옮겨 같은 파일에 이어 쓰고,
///   대상 화면이 돌아오면 다시 돌아간다.
/// 추가 화면(extra): 영상만. 화면이 빠지면 멈췄다가 다시 꽂으면 같은 파일에 이어 쓴다.
final class Capture: NSObject, SCStreamDelegate, SCStreamOutput {
  enum Role { case primary, extra }
  let role: Role
  var targetID: UInt32?          // nil = 자동(내장 화면 우선). 같은 모니터가 새 ID 로 돌아오면 바뀐다
  let targetFP: Fingerprint?
  let path: String
  let canFallback: Bool
  private(set) var writer: AVAssetWriter?
  private var vInput: AVAssetWriterInput?
  private var sysInput: AVAssetWriterInput?
  private var micInput: AVAssetWriterInput?
  private var outW = 0, outH = 0
  private var writing = false
  private(set) var appended = 0
  var finishing = false
  private let lock = NSLock()
  private var _stream: SCStream?
  private var _currentID: UInt32?
  var lastError = ""
  var quietReconnect = false   // 일시정지에서 다시 시작할 때 다시 연결하는 건 «화면 변화»로 기록하지 않는다
  let q: DispatchQueue

  var stream: SCStream? { lock.lock(); defer { lock.unlock() }; return _stream }
  var currentID: UInt32? { lock.lock(); defer { lock.unlock() }; return _currentID }
  private func setActive(_ s: SCStream?, _ id: UInt32?) { lock.lock(); _stream = s; _currentID = id; lock.unlock() }
  private func isActive(_ s: SCStream) -> Bool { lock.lock(); defer { lock.unlock() }; return _stream === s }
  var file: String { (path as NSString).lastPathComponent }

  init(_ role: Role, target: UInt32?, path: String, fallback: Bool) {
    self.role = role; targetID = target; self.path = path; canFallback = fallback
    targetFP = target.map(fingerprint)
    if let t = target { rememberName(t) }
    q = DispatchQueue(label: "capture.\(role == .primary ? "primary" : "extra").\(target ?? 0)")
  }

  /// 녹화할 화면 고르기: 대상 화면 → (옮기기 허용 시) 내장 화면 → 주 디스플레이 → 아무 화면
  func pick(_ ds: [SCDisplay]) -> SCDisplay? {
    if let t = targetID, let d = ds.first(where: { $0.displayID == t }) { return d }
    if targetID != nil && !canFallback { return nil }
    return ds.first { isBuiltin($0.displayID) } ?? ds.first { $0.displayID == CGMainDisplayID() } ?? ds.first
  }

  private func makeWriter(_ d: SCDisplay) throws {
    guard writer == nil else { return }
    let video = wantVideo
    if video { let (pw, ph) = pixelSize(d); (outW, outH) = scaledSize(pw, ph, scaleWidth) }
    try? FileManager.default.removeItem(atPath: path)
    let w = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: video ? .mp4 : .m4a)
    if video {
      let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: outW, AVVideoHeightKey: outH])
      v.expectsMediaDataInRealTime = true
      w.add(v); vInput = v
    }
    if role == .primary && wantSystem {
      let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 160000])
      a.expectsMediaDataInRealTime = true
      w.add(a); sysInput = a
    }
    if role == .primary && wantMic {
      let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 128000])
      a.expectsMediaDataInRealTime = true
      w.add(a); micInput = a
    }
    writer = w
  }

  /// 스트림 연결. 실패하면 false(대상 화면이 없거나 권한 문제) — 감시자가 나중에 다시 시도한다.
  func connect() async -> Bool {
    guard !finishing else { return false }
    if stream != nil { return true }
    let content: SCShareableContent
    do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
    catch { lastError = "화면 기록 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 MacRecorder Capture 를 켜 주세요. (\(error.localizedDescription))"; return false }
    guard let d = pick(content.displays) else { lastError = "녹화할 화면이 없습니다"; return false }
    do {
      try makeWriter(d)
      let cfg = SCStreamConfiguration()
      if wantVideo {
        cfg.width = outW; cfg.height = outH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        // 다른 크기의 화면으로 옮겨도 같은 파일 크기에 맞춰 넣는다(비율 유지, 남는 곳은 검정)
        cfg.scalesToFit = true
        cfg.preservesAspectRatio = true
      } else {
        // 소리만 녹음해도 시스템 소리를 받으려면 화면 스트림이 필요하다 → 아주 작게·느리게 받고 버린다
        let (w, h) = scaledSize(d.width, d.height, 320); cfg.width = w; cfg.height = h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 2)
      }
      cfg.queueDepth = 8
      cfg.showsCursor = true
      if role == .primary && wantSystem { cfg.capturesAudio = true; cfg.sampleRate = 48000; cfg.channelCount = 2; cfg.excludesCurrentProcessAudio = true }
      if role == .primary && wantMic { cfg.captureMicrophone = true; if let m = micDeviceID { cfg.microphoneCaptureDeviceID = m } }
      let s = SCStream(filter: SCContentFilter(display: d, excludingWindows: []), configuration: cfg, delegate: self)
      try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
      if role == .primary && wantSystem { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: q) }
      if role == .primary && wantMic { try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: q) }
      setActive(s, d.displayID)
      rememberName(d.displayID)
      do { try await s.startCapture() } catch { setActive(nil, nil); throw error }
      log("\(role == .primary ? "primary" : "extra") → display \(d.displayID) \(cfg.width)x\(cfg.height) file=\(file)")
      return true
    } catch {
      lastError = error.localizedDescription
      log("connect error (\(file)): \(error.localizedDescription)")
      return false
    }
  }

  func disconnect() async {
    guard let s = stream else { return }
    setActive(nil, nil)
    try? await s.stopCapture()
  }

  private var lastVideoPTS = CMTime.invalid
  /// 추가 화면이 빠진 순간 검정 화면을 한 장 넣는다. 안 넣으면 플레이어가 빠진 동안 마지막 장면을 계속 보여 준다.
  func appendBlank() {
    q.async { [self] in
      guard role == .extra, writing, let w = writer, w.status == .writing, let v = vInput, v.isReadyForMoreMediaData, outW > 0 else { return }
      var now = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), timeline.offset)
      if lastVideoPTS.isValid && now <= lastVideoPTS { now = CMTimeAdd(lastVideoPTS, CMTime(value: 1, timescale: 1000)) }
      var pb: CVPixelBuffer?
      let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
      guard CVPixelBufferCreate(nil, outW, outH, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb) == kCVReturnSuccess, let buf = pb else { return }
      CVPixelBufferLockBaseAddress(buf, [])
      if let base = CVPixelBufferGetBaseAddress(buf) { memset(base, 0, CVPixelBufferGetDataSize(buf)) }
      CVPixelBufferUnlockBaseAddress(buf, [])
      var fmt: CMVideoFormatDescription?
      guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buf, formatDescriptionOut: &fmt) == noErr, let f = fmt else { return }
      var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: now, decodeTimeStamp: .invalid)
      var sb: CMSampleBuffer?
      guard CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buf, formatDescription: f, sampleTiming: &timing, sampleBufferOut: &sb) == noErr, let sample = sb else { return }
      if v.append(sample) { lastVideoPTS = now; timeline.bump(now); log("blank frame → \(file)") }
    }
  }

  func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard !finishing, isActive(s), CMSampleBufferDataIsReady(sb), let w = writer else { return }
    if type == .screen {
      if let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
         let raw = arr.first?[.status] as? Int, let st = SCFrameStatus(rawValue: raw), st != .complete { return }
    }
    if timeline.isPaused { return }   // 일시정지 중에는 아무것도 쓰지 않는다
    var sb = sb
    let off = timeline.offset
    if off > .zero { guard let r = retimed(sb, by: off) else { return }; sb = r }
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    if !writing {
      if role == .primary {
        // 시작 기준: 영상 모드는 첫 화면 프레임, 소리 모드는 첫 오디오
        let trigger = wantVideo ? (type == .screen) : (type == .audio || type == .microphone)
        guard trigger else { return }
        let start = timeline.startIfNil(pts)
        w.startWriting(); w.startSession(atSourceTime: start)
      } else {
        // 추가 화면은 주 녹화의 시작 시각을 기준으로 삼는다(앞부분은 비어 있어도 시간축이 같다)
        guard type == .screen, let start = timeline.start, pts >= start else { return }
        w.startWriting(); w.startSession(atSourceTime: start)
      }
      writing = true
    }
    guard w.status == .writing else { return }
    var ok = false
    switch type {
    case .screen: if let v = vInput, v.isReadyForMoreMediaData { ok = v.append(sb); if ok { lastVideoPTS = pts } }
    case .audio: if let a = sysInput, a.isReadyForMoreMediaData { ok = a.append(sb) }
    case .microphone: if let a = micInput, a.isReadyForMoreMediaData { ok = a.append(sb) }
    @unknown default: break
    }
    if ok { appended += 1; timeline.bump(pts) }
  }

  func stream(_ s: SCStream, didStopWithError error: Error) {
    // 화면이 빠지거나(-3815 등) 잠자기로 스트림이 끊겼다. 녹화를 끝내지 않고 감시자에게 맡긴다.
    guard isActive(s) else { return }
    let was = currentID
    setActive(nil, nil)
    event(role == .primary ? "primary-lost" : "display-lost", was, error.localizedDescription, file: file)
    appendBlank()
    DispatchQueue.main.async { supervisor.kick() }
  }

  /// 파일 마무리. 모든 파일의 끝을 같은 시각으로 맞춘다(빠진 화면은 마지막 장면이 끝까지 유지된다).
  func finalize(end: CMTime?) async -> Bool {
    guard let w = writer else { return false }
    guard writing, w.status == .writing else {
      w.cancelWriting(); try? FileManager.default.removeItem(atPath: path); return false
    }
    vInput?.markAsFinished(); sysInput?.markAsFinished(); micInput?.markAsFinished()
    if let e = end { w.endSession(atSourceTime: e) }
    await w.finishWriting()
    log("finalized \(file) status=\(w.status.rawValue) samples=\(appended)")
    return w.status == .completed
  }
}

// MARK: - 감시자: 화면 변화에 맞춰 연결을 고친다

final class Supervisor {
  var captures: [Capture] = []
  var primary: Capture { captures[0] }
  var finishing = false
  private var busy = false
  private var again = false

  var paused = false
  var pausedSince: Date? = nil

  /// 일시정지: 모든 화면·소리 수집을 끊는다(macOS 화면 녹화 표시도 꺼진다). 파일은 열어 둔다.
  func pause() {
    guard !finishing, !paused else { return }
    paused = true; pausedSince = Date()
    timeline.pause(hostNow())
    event("paused", nil)
    Task { @MainActor in
      for c in self.captures { if c.stream != nil { c.quietReconnect = true }; await c.disconnect() }
      self.writeLive()
    }
  }
  /// 다시 시작: 같은 파일에 이어 쓴다. 멈춰 있던 시간은 파일에서 빠진다.
  func resume() {
    guard !finishing, paused else { return }
    let d = timeline.resume(hostNow())
    paused = false; pausedSince = nil
    event("resumed", nil, String(format: "%.1f초 멈춤", d))
    kick()
  }

  func kick() {
    guard !finishing, !paused else { return }
    if busy { again = true; return }
    busy = true
    Task { @MainActor in
      repeat { again = false; await self.tick() } while again && !finishing
      busy = false
      writeLive()
    }
  }

  @MainActor func tick() async {
    let online = Set(onlineDisplayIDs())
    for id in online { rememberName(id) }
    refreshNames(online)
    // 0) 대상 모니터가 다른 화면 ID 로 돌아왔으면(제조사·모델·일련번호가 같음) 그 ID 로 대상을 바꾼다
    for c in captures where !c.finishing {
      guard let t = c.targetID, !online.contains(t), let fp = c.targetFP else { continue }
      let claimed = Set(captures.compactMap { $0.targetID })
      if let id = online.sorted().first(where: { !claimed.contains($0) && fingerprint($0) == fp }) {
        log("display \(t) returned as \(id)")
        if let n = displayNames[t] { realNames.remove(id); displayNames[id] = n; realNames.insert(id) }
        c.targetID = id
      }
    }
    for c in captures where !c.finishing {
      // 1) 연결된 화면이 목록에서 빠졌으면 먼저 끊는다(스트림 오류보다 화면 변경 알림이 빨리 올 때가 있다)
      if let cur = c.currentID, !online.contains(cur) {
        await c.disconnect()
        event(c.role == .primary ? "primary-lost" : "display-lost", cur, "화면 연결 해제", file: c.file)
        c.appendBlank()
      }
      if c.stream == nil {
        // 2) 끊겨 있으면 다시 연결. 추가 화면은 자기 화면이 돌아왔을 때만
        if c.role == .extra, let t = c.targetID, !online.contains(t) { continue }
        if await c.connect(), let now = c.currentID {
          if c.quietReconnect { c.quietReconnect = false; continue }
          if c.role == .primary {
            event(c.targetID == nil || now == c.targetID ? "primary-resumed" : "primary-moved", now, file: c.file)
          } else { event("display-resumed", now, file: c.file) }
        }
      } else if c.role == .primary, let t = c.targetID, let cur = c.currentID, cur != t, online.contains(t) {
        // 3) 주 녹화가 다른 화면으로 옮겨 가 있는데 원래 화면이 돌아왔으면 되돌린다
        await c.disconnect()
        if await c.connect(), let now = c.currentID { event("primary-returned", now, file: c.file) }
      }
    }
    // 4) «전체 화면» 녹화 중 새로 꽂은 화면은 녹화에 더한다
    if allDisplays && wantVideo {
      let known = Set(captures.compactMap { $0.targetID })
      for id in online.sorted() where !known.contains(id) && id != primary.currentID {
        var name = "display-\(id).mp4", k = 2
        while FileManager.default.fileExists(atPath: (outDir as NSString).appendingPathComponent(name)) { name = "display-\(id)-\(k).mp4"; k += 1 }
        let c = Capture(.extra, target: id, path: (outDir as NSString).appendingPathComponent(name), fallback: false)
        captures.append(c)
        if await c.connect() { event("display-added", id, file: c.file) }
      }
    }
  }

  func writeLive() {
    let ev = eventSnapshot()
    let files: [[String: Any]] = captures.map { c in
      var o: [String: Any] = ["file": c.file, "role": c.role == .primary ? "primary" : "extra", "recording": c.stream != nil]
      if let t = c.targetID { o["display"] = Int(t); o["name"] = displayName(t); o["x"] = Int(CGDisplayBounds(t).origin.x) }
      if let cur = c.currentID { o["current"] = Int(cur) }
      return o
    }
    var extra: [String: Any] = ["events": ev, "files": files, "paused": paused, "pausedTotalSec": timeline.pausedTotal]
    if let p = pausedSince { extra["pausedSince"] = iso.string(from: p) }
    writeStatus(finishing ? "finishing" : (paused ? "paused" : "recording"), extra)
  }

  func finish(reason: String) {
    if finishing { return }
    finishing = true
    for c in captures { c.finishing = true }
    writeStatus("finishing", ["reason": reason])
    Task {
      for c in self.captures { await c.disconnect() }
      let end = timeline.latest
      var results: [String: Bool] = [:]
      for c in self.captures { results[c.file] = await c.finalize(end: end) }
      let ok = results[self.primary.file] == true
      log("finished ok=\(ok) reason=\(reason)")
      if ok { spawnMixer(outPath) }
      let ev = eventSnapshot()
      let files: [[String: Any]] = self.captures.filter { results[$0.file] == true }.map { c in
        var o: [String: Any] = ["file": c.file, "role": c.role == .primary ? "primary" : "extra"]
        if let t = c.targetID { o["display"] = Int(t); o["name"] = displayName(t); o["x"] = Int(CGDisplayBounds(t).origin.x) }
        return o
      }
      writeStatus(ok ? "finished" : "failed", ok
        ? ["reason": reason, "events": ev, "files": files]
        : ["error": "녹화 파일을 만들지 못했습니다(녹화가 시작되기 전에 멈췄을 수 있음).", "reason": reason, "events": ev])
      exit(ok ? 0 : 1)
    }
  }
}
let supervisor = Supervisor()

// MARK: - 시작

statusBase = ["out": outPath, "startedAt": iso.string(from: Date()), "video": wantVideo, "mic": wantMic, "system": wantSystem]
writeStatus("starting")

// 주 녹화 대상: 화면을 지정했으면 그 화면, «전체 화면»이면 가장 빠지지 않는 내장 화면(없으면 주 디스플레이).
// 이전에는 «주 디스플레이»(대개 외장 모니터)에 소리를 실어서, HDMI 를 빼면 녹화 전체가 끝났다.
let online0 = onlineDisplayIDs()
var primaryTarget: UInt32? = displayID
if displayID == nil && wantVideo {
  primaryTarget = online0.first(where: isBuiltin) ?? (online0.contains(CGMainDisplayID()) ? CGMainDisplayID() : online0.first)
}
for id in online0 { _ = displayName(id) }
supervisor.captures.append(Capture(.primary, target: primaryTarget, path: outPath, fallback: fallback))
if allDisplays && wantVideo {
  for id in online0 where id != primaryTarget {
    supervisor.captures.append(Capture(.extra, target: id, path: (outDir as NSString).appendingPathComponent("display-\(id).mp4"), fallback: false))
  }
}

var signalSources: [DispatchSourceSignal] = []
// 일시정지·다시 시작은 서버가 신호로 보낸다: SIGUSR1 = 일시정지, SIGUSR2 = 다시 시작
for (sig, f) in [(SIGUSR1, { supervisor.pause() }), (SIGUSR2, { supervisor.resume() })] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler(handler: f)
  src.resume()
  signalSources.append(src)
}
for sig in [SIGINT, SIGTERM, SIGHUP] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { supervisor.finish(reason: "signal \(sig)") }
  src.resume()
  signalSources.append(src)
}

// 1초마다 화면 구성을 점검한다(꽂기·빼기·덮개·잠자기에서 깨어남).
// macOS 의 화면 변경 알림(CGDisplayRegisterReconfigurationCallback)은 이 백그라운드 프로세스에 오지 않아(실측) 쓰지 않는다.
// 점검 자체는 화면 ID 목록 비교라 가볍다. 끊긴 스트림이 있을 때만 다시 연결을 시도한다.
let ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in supervisor.kick() }

Task { @MainActor in
  let p = supervisor.primary
  guard await p.connect() else {
    log("start error: \(p.lastError)")
    writeStatus("failed", ["error": p.lastError])
    exit(2)
  }
  event("start", p.currentID, file: p.file)
  for c in supervisor.captures.dropFirst() { if await c.connect() { event("start", c.currentID, file: c.file) } }
  supervisor.writeLive()
}
RunLoop.main.run()
