import AppKit

// A vector-drawn document mark using the editor's blue palette. Render each
// icon size directly so small Spotlight/Dock icons stay crisp on Retina screens.
let directory = CommandLine.arguments[1]
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                      isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let context = NSGraphicsContext.current!.cgContext
        context.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
        let background = NSBezierPath(roundedRect: NSRect(x: 56, y: 56, width: 912, height: 912), xRadius: 210, yRadius: 210)
        NSGradient(starting: NSColor(srgbRed: 0.31, green: 0.55, blue: 0.96, alpha: 1),
                   ending: NSColor(srgbRed: 0.08, green: 0.34, blue: 0.79, alpha: 1))!.draw(in: background, angle: -90)
        NSColor.white.withAlphaComponent(0.20).setStroke()
        background.lineWidth = 5
        background.stroke()
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.2)
        shadow.shadowBlurRadius = 30
        shadow.shadowOffset = NSSize(width: 0, height: -16)
        shadow.set()
        NSColor.white.setFill()
        NSBezierPath(roundedRect: NSRect(x: 265, y: 206, width: 494, height: 612), xRadius: 46, yRadius: 46).fill()
        NSGraphicsContext.restoreGraphicsState()
        NSColor(srgbRed: 0.10, green: 0.45, blue: 0.91, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 334, y: 670, width: 214, height: 42), xRadius: 21, yRadius: 21).fill()
        for y in [562, 465, 368] {
            NSColor(srgbRed: 0.64, green: 0.75, blue: 0.91, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: 334, y: y, width: 26, height: 26)).fill()
            NSBezierPath(roundedRect: NSRect(x: 387, y: y, width: y == 368 ? 193 : 303, height: 26), xRadius: 13, yRadius: 13).fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(directory)/icon_\(size)x\(size)\(suffix).png"))
    }
}
