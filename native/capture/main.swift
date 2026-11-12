// MacRecorder Capture — ScreenCaptureKit 녹화 엔진
//
// 화면 + 시스템 소리 + 마이크를 하나의 SCStream 으로 동기 캡처해 파일 하나에 담는다.
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
var extraSpecs: [(UInt32, String)] = []
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
    case "--extra":
      let parts = next().split(separator: ":", maxSplits: 1).map(String.init)
      if parts.count == 2, let id = UInt32(parts[0]) { extraSpecs.append((id, parts[1])) }
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

/// 녹화가 끝난 뒤 재생용 믹스 파일을 만든다(마이크+시스템 소리가 둘 다 있을 때만).
/// 여기(finalize 직후)에 두는 이유: 잠자기로 스트림이 끊기는 경로까지 한 곳에서 처리된다.
@Sendable func spawnMixer(_ media: String) {
  guard wantMic, wantSystem, let script = mixScript, FileManager.default.isExecutableFile(atPath: script) else { return }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/bash")
  p.arguments = [script, media]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  do { try p.run(); log("mixer pid=\(p.processIdentifier)") } catch { log("mixer error: \(error)") }
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

/// 다중 모니터의 나머지 화면 — 영상만 담는다. 레코더 프로세스를 화면마다 띄우면 SCK 가 서로를 끊으므로
/// 한 프로세스 안에서 스트림을 여러 개 연다.
final class ExtraStream: NSObject, SCStreamDelegate, SCStreamOutput {
  let displayID: UInt32
  let path: String
  var stream: SCStream?
  var writer: AVAssetWriter?
  var input: AVAssetWriterInput?
  var started = false
  var finishing = false
  let q = DispatchQueue(label: "capture.extra")

  init(_ id: UInt32, _ path: String) { displayID = id; self.path = path }

  func start(_ content: SCShareableContent) async throws {
    guard let d = content.displays.first(where: { $0.displayID == displayID }) else { log("extra \(displayID) 없음"); return }
    let cfg = SCStreamConfiguration()
    let (pw, ph) = pixelSize(d)
    (cfg.width, cfg.height) = scaledSize(pw, ph, scaleWidth)
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.queueDepth = 8
    cfg.showsCursor = true
    try? FileManager.default.removeItem(atPath: path)
    let w = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mp4)
    let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: cfg.width, AVVideoHeightKey: cfg.height])
    inp.expectsMediaDataInRealTime = true
    w.add(inp); writer = w; input = inp
    stream = SCStream(filter: SCContentFilter(display: d, excludingWindows: []), configuration: cfg, delegate: self)
    try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
    try await stream!.startCapture()
    log("extra display=\(displayID) \(cfg.width)x\(cfg.height) → \(path)")
  }

  func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !finishing, CMSampleBufferDataIsReady(sb), let w = writer, let inp = input else { return }
    if let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
       let raw = arr.first?[.status] as? Int, let st = SCFrameStatus(rawValue: raw), st != .complete { return }
    if !started { w.startWriting(); w.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sb)); started = true }
    if inp.isReadyForMoreMediaData { inp.append(sb) }
  }

  func stream(_ s: SCStream, didStopWithError error: Error) { log("extra \(displayID) stopped: \(error)") }

  func finalize() async {
    finishing = true
    try? await stream?.stopCapture()
    guard let w = writer, w.status == .writing else { return }
    input?.markAsFinished()
    await w.finishWriting()
  }
}

final class Recorder: NSObject, SCStreamDelegate, SCStreamOutput {
  var extras: [ExtraStream] = []
  var stream: SCStream?
  var writer: AVAssetWriter!
  var vInput: AVAssetWriterInput?
  var sysInput: AVAssetWriterInput?
  var micInput: AVAssetWriterInput?
  var started = false
  var finishing = false
  let q = DispatchQueue(label: "capture.samples")

  func start() async throws {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
      throw NSError(domain: "capture", code: 2, userInfo: [NSLocalizedDescriptionKey:
        "화면 기록 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 MacRecorder Capture 를 켜 주세요. (\(error.localizedDescription))"])
    }
    guard !content.displays.isEmpty else {
      throw NSError(domain: "capture", code: 2, userInfo: [NSLocalizedDescriptionKey: "화면을 찾지 못했습니다(화면 기록 권한 확인)."])
    }
    let display = displayID.flatMap { id in content.displays.first { $0.displayID == id } }
      ?? content.displays.first { $0.displayID == CGMainDisplayID() } ?? content.displays[0]

    let cfg = SCStreamConfiguration()
    if wantVideo {
      // 실제 픽셀 크기에서 --width 로 줄인다(0 이면 원본)
      let (pw, ph) = pixelSize(display)
      (cfg.width, cfg.height) = scaledSize(pw, ph, scaleWidth)
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    } else {
      // 오디오 전용도 시스템 소리를 받으려면 디스플레이 스트림이 필요하다 → 아주 작게·느리게 받고 버린다
      (cfg.width, cfg.height) = scaledSize(display.width, display.height, 320)
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: 2)
    }
    cfg.queueDepth = 8
    cfg.showsCursor = true
    if wantSystem { cfg.capturesAudio = true; cfg.sampleRate = 48000; cfg.channelCount = 2; cfg.excludesCurrentProcessAudio = true }
    if wantMic {
      cfg.captureMicrophone = true
      if let m = micDeviceID { cfg.microphoneCaptureDeviceID = m }
    }

    try? FileManager.default.removeItem(atPath: outPath)
    writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: outPath), fileType: wantVideo ? .mp4 : .m4a)
    if wantVideo {
      let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: cfg.width, AVVideoHeightKey: cfg.height])
      v.expectsMediaDataInRealTime = true
      writer.add(v); vInput = v
    }
    if wantSystem {
      let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 160000])
      a.expectsMediaDataInRealTime = true
      writer.add(a); sysInput = a
    }
    if wantMic {
      let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 128000])
      a.expectsMediaDataInRealTime = true
      writer.add(a); micInput = a
    }

    stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: self)
    try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
    if wantSystem { try stream!.addStreamOutput(self, type: .audio, sampleHandlerQueue: q) }
    if wantMic { try stream!.addStreamOutput(self, type: .microphone, sampleHandlerQueue: q) }
    try await stream!.startCapture()
    log("recording display=\(display.displayID) \(cfg.width)x\(cfg.height) video=\(wantVideo) system=\(wantSystem) mic=\(wantMic) → \(outPath)")
    for (id, p) in extraSpecs where wantVideo {
      let e = ExtraStream(id, p)
      do { try await e.start(content); extras.append(e) } catch { log("extra \(id) error: \(error)") }
    }
    writeStatus("recording", ["display": Int(display.displayID)])
  }

  func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard !finishing, CMSampleBufferDataIsReady(sb) else { return }
    if type == .screen {
      if let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
         let raw = arr.first?[.status] as? Int, let st = SCFrameStatus(rawValue: raw), st != .complete { return }
    }
    if !started {
      // 시작 기준: 영상 모드는 첫 화면 프레임, 오디오 모드는 첫 오디오 버퍼
      let trigger = wantVideo ? (type == .screen) : (type == .audio || type == .microphone)
      guard trigger else { return }
      writer.startWriting()
      writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sb))
      started = true
    }
    switch type {
    case .screen: if let v = vInput, v.isReadyForMoreMediaData { v.append(sb) }
    case .audio: if let a = sysInput, a.isReadyForMoreMediaData { a.append(sb) }
    case .microphone: if let a = micInput, a.isReadyForMoreMediaData { a.append(sb) }
    @unknown default: break
    }
  }

  func stream(_ s: SCStream, didStopWithError error: Error) {
    // 잠자기·덮개 닫힘으로 화면이 사라지면 SCK 가 스트림을 끊는다. 여기서도 반드시 파일을 마무리해야
    // moov 아톰이 써져 재생 가능한 파일이 남는다.
    log("stream stopped: \(error.localizedDescription)")
    finish(reason: "stream-stopped: \(error.localizedDescription)")
  }

  func finish(reason: String = "stopped") {
    if finishing { return }
    finishing = true
    writeStatus("finishing", ["reason": reason])
    q.async {
      Task {
        try? await self.stream?.stopCapture()
        for e in self.extras { await e.finalize() }
        // 첫 프레임 전에 멈추면 writer 가 시작 전이라 markAsFinished 가 예외를 낸다 → writing 일 때만
        if self.writer?.status == .writing {
          self.vInput?.markAsFinished(); self.sysInput?.markAsFinished(); self.micInput?.markAsFinished()
          await self.writer.finishWriting()
        }
        let ok = self.writer?.status == .completed
        log("finished ok=\(ok) reason=\(reason)")
        if ok { spawnMixer(outPath) }
        writeStatus(ok ? "finished" : "failed", ok ? ["reason": reason] : ["error": "녹화 파일을 만들지 못했습니다(녹화가 시작되기 전에 멈췄을 수 있음).", "reason": reason])
        exit(ok ? 0 : 1)
      }
    }
  }
}

statusBase = ["out": outPath, "startedAt": ISO8601DateFormatter().string(from: Date()),
              "video": wantVideo, "mic": wantMic, "system": wantSystem]
writeStatus("starting")
let rec = Recorder()
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM, SIGHUP] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { rec.finish(reason: "signal \(sig)") }
  src.resume()
  signalSources.append(src)
}
Task {
  do { try await rec.start() } catch {
    log("start error: \(error.localizedDescription)")
    writeStatus("failed", ["error": error.localizedDescription])
    exit(2)
  }
}
RunLoop.main.run()
