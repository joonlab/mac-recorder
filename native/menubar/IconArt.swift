// 메뉴바 아이콘 — 앱 아이콘(카메라 조리개)과 같은 모양을 벡터로 그린다.
// 대기: 템플릿 이미지(메뉴바 글자색을 따라 밝은·어두운 메뉴바 모두 자연스럽게). 조리개 날 6개 + 가운데 육각 구멍.
// 녹화 중: 가운데 구멍을 빨갛게 채운다. 날은 그릴 때의 메뉴바 글자색(labelColor)을 쓴다.
import AppKit

enum IconArt {
  static let red = NSColor(srgbRed: 0.898, green: 0.282, blue: 0.302, alpha: 1)

  static let amber = NSColor(srgbRed: 0.93, green: 0.58, blue: 0.13, alpha: 1)

  static func menuBar(recording: Bool, paused: Bool = false, pulse: Bool = false) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size, flipped: false) { _ in
      let c = NSPoint(x: 9, y: 9)
      let R: CGFloat = 7.6                       // 바깥 원
      let r: CGFloat = recording ? 3.3 : 2.7     // 가운데 육각 구멍(꼭짓점까지)
      let ink = recording ? NSColor.labelColor : NSColor.black
      ink.setStroke()

      let ring = NSBezierPath(ovalIn: NSRect(x: c.x - R, y: c.y - R, width: R * 2, height: R * 2))
      ring.lineWidth = 1.4
      ring.stroke()

      // 조리개 날: 육각 구멍의 각 변을 바깥 원까지 연장한 선 6개(시계 방향으로 비틀린 모양)
      let blades = NSBezierPath()
      blades.lineWidth = 1.15
      blades.lineCapStyle = .round
      for k in 0..<6 {
        let a1 = CGFloat(k) * .pi / 3 + .pi / 6
        let a2 = a1 + .pi / 3
        let p1 = NSPoint(x: c.x + r * cos(a1), y: c.y + r * sin(a1))
        let p2 = NSPoint(x: c.x + r * cos(a2), y: c.y + r * sin(a2))
        // p1→p2 방향으로 원에 닿을 때까지 연장
        let dx = p2.x - p1.x, dy = p2.y - p1.y
        let len = sqrt(dx * dx + dy * dy)
        let ux = dx / len, uy = dy / len
        let fx = p1.x - c.x, fy = p1.y - c.y
        let b = fx * ux + fy * uy
        let t = -b + sqrt(b * b - (fx * fx + fy * fy - (R - 0.6) * (R - 0.6)))
        blades.move(to: p1)
        blades.line(to: NSPoint(x: p1.x + ux * t, y: p1.y + uy * t))
      }
      blades.stroke()

      if recording && paused {
        // 일시정지: 가운데에 주황색 막대 두 개
        amber.setFill()
        NSBezierPath(roundedRect: NSRect(x: c.x - 2.6, y: c.y - 2.8, width: 1.9, height: 5.6), xRadius: 0.6, yRadius: 0.6).fill()
        NSBezierPath(roundedRect: NSRect(x: c.x + 0.7, y: c.y - 2.8, width: 1.9, height: 5.6), xRadius: 0.6, yRadius: 0.6).fill()
      } else if recording {
        let hole = NSBezierPath()
        for k in 0..<6 {
          let a = CGFloat(k) * .pi / 3 + .pi / 6
          let p = NSPoint(x: c.x + (r + (pulse ? 0.5 : 0)) * cos(a), y: c.y + (r + (pulse ? 0.5 : 0)) * sin(a))
          if k == 0 { hole.move(to: p) } else { hole.line(to: p) }
        }
        hole.close()
        red.setFill()
        hole.fill()
      }
      return true
    }
    img.isTemplate = !recording
    img.accessibilityDescription = recording ? (paused ? "MacRecorder 일시정지" : "MacRecorder 녹화 중") : "MacRecorder"
    return img
  }
}
